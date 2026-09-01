import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCinesimLogger } from "@cinesim/logging";
import { projectViewFromIr } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import { searchLanguageReference } from "@cinesim/compiler";
import { localDerivedFile, registerCinesimMcpTools } from "@cinesim/mcp-tools";
import type { CinesimMcpToolRuntime } from "@cinesim/mcp-tools";
import {
  parseProjectManifest,
  ProjectPaths,
  sourceFingerprintForPath,
  SourceProjectRepository,
  VisualIndexStore,
  type SourceProjectSnapshot,
} from "@cinesim/project-io";

const log = createCinesimLogger({ service: "mcp" });

interface LiveBroker {
  url: string;
  token: string;
}

const textResult = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

function failure(error: unknown) {
  log.error({ err: error }, "MCP operation failed");
  return {
    isError: true,
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
    ],
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Transcript artifact is invalid");
  return value as Record<string, unknown>;
}

function boundedTranscriptWords(
  value: unknown,
  fromUs: number,
  toUs: number | undefined,
  limit: number,
): { words: Record<string, unknown>[]; truncated: boolean } {
  if (toUs !== undefined && toUs <= fromUs) throw new Error("toUs must be greater than fromUs");
  const endUs = toUs ?? Number.MAX_SAFE_INTEGER;
  const words = Array.isArray(value)
    ? value
        .map((word) => objectRecord(word))
        .filter(
          (word) =>
            typeof word.sourceStartUs === "number" &&
            typeof word.sourceEndUs === "number" &&
            word.sourceEndUs > fromUs &&
            word.sourceStartUs < endUs,
        )
    : [];
  return { words: words.slice(0, limit), truncated: words.length > limit };
}

function brokerHeaders(broker: LiveBroker): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${broker.token}`,
    "Content-Type": "application/json",
  };
}

async function discoverLiveBroker(
  projectDirectory: string,
  paths: ProjectPaths,
): Promise<LiveBroker | null> {
  try {
    const path = await paths.assertSafeDerivedFile(".video/mcp/broker.json", false);
    const input = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (input.version !== 1 || typeof input.projectDirectory !== "string") return null;
    if ((await realpath(input.projectDirectory)) !== (await realpath(projectDirectory)))
      return null;
    if (typeof input.url !== "string" || typeof input.token !== "string") return null;
    const url = new URL(input.url);
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost"))
      return null;
    if (!/^[a-f0-9]{64}$/u.test(input.token)) return null;
    const broker = { url: url.toString(), token: input.token };
    return (await probeLiveBroker(broker)) ? broker : null;
  } catch {
    return null;
  }
}

async function probeLiveBroker(broker: LiveBroker): Promise<boolean> {
  try {
    const response = await fetch(broker.url, {
      method: "POST",
      headers: brokerHeaders(broker),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "cinesim-broker-probe",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cinesim-broker-probe", version: "0.1.0" },
        },
      }),
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok && (await response.text()).includes("cinesim-broker-probe");
  } catch {
    return false;
  }
}

function responseMessages(body: string, contentType: string | null): string[] {
  if (!body.trim()) return [];
  if (!contentType?.includes("text/event-stream")) return [body.trim()];
  return body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
}

async function bridgeLiveBroker(broker: LiveBroker): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      const response = await fetch(broker.url, {
        method: "POST",
        headers: brokerHeaders(broker),
        body: line,
      });
      const body = await response.text();
      for (const message of responseMessages(body, response.headers.get("content-type")))
        process.stdout.write(`${message}\n`);
    } catch (error) {
      log.error({ err: error }, "Live desktop MCP bridge request failed");
    }
  }
}

async function lastAcceptedStatus(
  projectDirectory: string,
  paths: ProjectPaths,
): Promise<Record<string, unknown>> {
  try {
    const journal = JSON.parse(
      await readFile(
        await paths.assertSafeDerivedFile(".video/history/journal.json", false),
        "utf8",
      ),
    ) as { entries?: unknown; index?: unknown };
    const entries = Array.isArray(journal.entries) ? journal.entries : [];
    const index = typeof journal.index === "number" ? journal.index : -1;
    const generation = entries[index];
    if (typeof generation !== "string" || !/^[a-f0-9]{64}$/u.test(generation))
      return { acceptedGeneration: null, lastValidComposition: null };
    const state = JSON.parse(
      await readFile(
        await paths.assertSafeDerivedFile(`.video/history/states/${generation}.json`, false),
        "utf8",
      ),
    ) as { manifestSource?: unknown };
    const manifest =
      typeof state.manifestSource === "string" ? parseProjectManifest(state.manifestSource) : null;
    return {
      acceptedGeneration: generation,
      lastValidComposition: manifest?.project.activeCompositionId ?? null,
      directory: projectDirectory,
    };
  } catch {
    return { acceptedGeneration: null, lastValidComposition: null, directory: projectDirectory };
  }
}

export async function runMcpServer(projectDirectory: string): Promise<void> {
  const projectPaths = await ProjectPaths.open(projectDirectory);
  const broker = await discoverLiveBroker(projectDirectory, projectPaths);
  if (broker) {
    await bridgeLiveBroker(broker);
    return;
  }
  const server = new McpServer({ name: "cinesim", version: "0.1.0" });
  const toolContext = new AsyncLocalStorage<SourceProjectSnapshot>();
  const snapshot = (): SourceProjectSnapshot => {
    const current = toolContext.getStore();
    if (!current) throw new Error("Project tool context is not loaded");
    return current;
  };
  const projectFromSnapshot = (current: SourceProjectSnapshot): Project =>
    projectViewFromIr(current.compilation.ir, {
      name: current.manifest.project.name,
      assets: current.assets,
      notes: current.manifest.notes,
      ...(current.manifest.project.cloudProjectId
        ? { cloudProjectId: current.manifest.project.cloudProjectId as Project["cloudProjectId"] }
        : {}),
    });
  const project = (): Project => projectFromSnapshot(snapshot());
  const visualIndexFor = (currentProject: Project): VisualIndexStore => {
    const store = new VisualIndexStore(async (assetId) => {
      const asset = currentProject.assets.find(({ id }) => id === assetId);
      if (!asset) throw new Error(`Unknown asset: ${assetId}`);
      return asset.source.kind === "local"
        ? sourceFingerprintForPath(asset.source.path)
        : { size: -1, mtimeMs: -1, edgeHash: "missing" };
    });
    store.setProject(projectDirectory, currentProject);
    return store;
  };
  const diskVisualIndexStatus = async (currentProject: Project) => {
    try {
      return await visualIndexFor(currentProject).status();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const runtime: CinesimMcpToolRuntime = {
    project,
    program: () => snapshot().compilation.ir,
    editMap: () => snapshot().compilation.sourceMap,
    directory: () => projectDirectory,
    projectStatus: async () => {
      try {
        const loaded = await SourceProjectRepository.inspect(projectDirectory);
        const currentProject = projectFromSnapshot(loaded);
        return {
          acceptedGeneration: loaded.generation,
          diskValid: true,
          candidateDiagnostics: [],
          diagnosticsTruncated: false,
          lastValidComposition: loaded.manifest.project.activeCompositionId,
          backgroundJobs: null,
          visualIndexes: await diskVisualIndexStatus(currentProject),
        };
      } catch (error) {
        return {
          ...(await lastAcceptedStatus(projectDirectory, projectPaths)),
          diskValid: false,
          candidateDiagnostics: [
            {
              severity: "error",
              code: "SOURCE_RELOAD_FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
          diagnosticsTruncated: false,
          backgroundJobs: null,
        };
      }
    },
    languageSearch: async (query, limit) =>
      searchLanguageReference(query, limit) as unknown as Record<string, unknown>[],
    transcriptGet: async (assetId, fromUs, toUs, limit, observationId) => {
      if (!project().assets.some((asset) => asset.id === assetId))
        throw new Error(`Unknown asset: ${assetId}`);
      const observationRange = observationId
        ? await visualIndexFor(project()).observationRange(assetId, observationId)
        : null;
      const selectedFromUs = observationRange?.sourceInUs ?? fromUs;
      const selectedToUs = observationRange?.sourceOutUs ?? toUs;
      const path = await projectPaths.assertSafeDerivedFile(
        `.video/transcripts/${assetId}.json`,
        false,
      );
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 16 * 1024 * 1024)
        throw new Error("Transcript artifact is unavailable or too large for MCP inspection");
      const artifact = objectRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (artifact.assetId !== assetId) throw new Error("Transcript artifact asset mismatch");
      return {
        assetId,
        state: "ready",
        language: artifact.language,
        sourceFingerprint: artifact.sourceFingerprint,
        ...(observationId ? { observationId } : {}),
        ...boundedTranscriptWords(artifact.words, selectedFromUs, selectedToUs, limit),
      };
    },
    timelineTranscriptGet: async () => {
      throw new Error("Timeline transcript projection requires the live Cinesim desktop broker");
    },
    transcriptJobs: async () => {
      throw new Error("Transcript jobs require the live Cinesim desktop broker");
    },
    visualIndexStatus: async (assetIds) => ({
      assets: await visualIndexFor(project()).status(assetIds),
    }),
    visualIndexGet: async (assetId, fromUs, toUs, limit) =>
      visualIndexFor(project()).get(assetId, {
        fromUs,
        ...(toUs === undefined ? {} : { toUs }),
        limit,
      }),
    visualIndexGenerate: async () => {
      throw new Error("Visual-index generation requires the live Cinesim desktop broker");
    },
    visualIndexUpsert: async () => {
      throw new Error("Visual-index updates require the live Cinesim desktop broker");
    },
    visualIndexDelete: async () => {
      throw new Error("Visual-index updates require the live Cinesim desktop broker");
    },
    visualIndexClear: async () => {
      throw new Error("Visual-index updates require the live Cinesim desktop broker");
    },
    visualIndexObservationRange: (assetId, observationId) =>
      visualIndexFor(project()).observationRange(assetId, observationId),
    perform: async (tool, operation) => {
      try {
        if (tool.name === "project_status") return textResult(await operation());
        const loaded = await SourceProjectRepository.inspect(projectDirectory);
        return textResult(await toolContext.run(loaded, operation));
      } catch (error) {
        return failure(error);
      }
    },
    derivedFile: async (relativePath) => {
      const path = await projectPaths.assertSafeDerivedFile(relativePath);
      return localDerivedFile(path);
    },
  };
  registerCinesimMcpTools(server, runtime);
  await server.connect(new StdioServerTransport());
}

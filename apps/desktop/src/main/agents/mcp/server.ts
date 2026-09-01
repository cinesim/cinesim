import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localDerivedFile, registerCinesimMcpTools } from "@cinesim/mcp-tools";
import type { CinesimMcpToolRuntime } from "@cinesim/mcp-tools";
import { searchLanguageReference } from "@cinesim/compiler";
import { timeUs } from "@cinesim/core";
import { ProjectPaths } from "@cinesim/project-io";
import type { AgentPermissionMode } from "../../../shared/contracts";
import type { DesktopProjectStore } from "../../projects/project-store";
import { projectTimelineTranscript } from "../../../shared/transcript";
import type { TranscriptSnapshot } from "../../../shared/transcript";

interface AgentToolSession {
  sessionId: string;
  token: string;
  projectDirectory: string;
  permissionMode: AgentPermissionMode;
  external: boolean;
}

interface ProjectBroker {
  directory: string;
  path: string;
  sessionId: string;
}

export interface AgentToolHooks {
  onToolStarted(sessionId: string, toolName: string, detail: string): Promise<string>;
  onToolCompleted(
    sessionId: string,
    eventId: string,
    toolName: string,
    detail: string,
    failed?: boolean,
  ): Promise<void>;
  requestApproval(sessionId: string, toolName: string, detail: string): Promise<boolean>;
  onProjectChanged(): void;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 1024 * 1024) throw new Error("MCP request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function jsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function rangeEnd(fromUs: number, toUs: number | undefined): number {
  if (toUs !== undefined && toUs <= fromUs) throw new Error("toUs must be greater than fromUs");
  return toUs ?? Number.MAX_SAFE_INTEGER;
}

function transcriptStates(snapshot: TranscriptSnapshot): Record<string, unknown> {
  return {
    assets: Object.fromEntries(
      Object.entries(snapshot.assets).map(([assetId, record]) => [
        assetId,
        {
          state: record?.state ?? "missing",
          ...(record?.failureCode ? { failureCode: record.failureCode } : {}),
        },
      ]),
    ),
  };
}

export class AgentMcpServer {
  #sessionsByToken = new Map<string, AgentToolSession>();
  #server = createServer((request, response) => void this.#handle(request, response));
  #url: string | null = null;
  #broker: ProjectBroker | null = null;
  #brokerQueue: Promise<void> = Promise.resolve();
  #unsubscribeProject: (() => void) | null = null;

  constructor(
    private readonly projectStore: DesktopProjectStore,
    private readonly hooks: AgentToolHooks,
  ) {}

  async start(): Promise<void> {
    if (this.#url) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind agent MCP server");
    this.#url = `http://127.0.0.1:${address.port}/mcp`;
    this.#unsubscribeProject = this.projectStore.subscribe(() => this.#scheduleBrokerSync());
    await this.#syncProjectBroker();
  }

  registerSession(input: {
    sessionId: string;
    projectDirectory: string;
    permissionMode: AgentPermissionMode;
  }): { url: string; token: string } {
    if (!this.#url) throw new Error("Agent MCP server has not started");
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    this.#sessionsByToken.set(token, { ...input, token, external: false });
    return { url: this.#url, token };
  }

  revokeSession(sessionId: string): void {
    for (const [token, session] of this.#sessionsByToken) {
      if (session.sessionId === sessionId) this.#sessionsByToken.delete(token);
    }
  }

  async close(): Promise<void> {
    this.#unsubscribeProject?.();
    this.#unsubscribeProject = null;
    await this.#brokerQueue.catch(() => undefined);
    await this.#removeBroker();
    this.#sessionsByToken.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #scheduleBrokerSync(): void {
    this.#brokerQueue = this.#brokerQueue
      .catch(() => undefined)
      .then(() => this.#syncProjectBroker());
  }

  async #syncProjectBroker(): Promise<void> {
    const projectDirectory = this.projectStore.directory;
    if (!this.#url || !projectDirectory) {
      await this.#removeBroker();
      return;
    }
    if (this.#broker?.directory === projectDirectory) return;
    await this.#removeBroker();
    const sessionId = `external:${crypto.randomUUID()}`;
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    this.#sessionsByToken.set(token, {
      sessionId,
      token,
      projectDirectory,
      permissionMode: "auto-edit",
      external: true,
    });
    const paths = await ProjectPaths.open(projectDirectory);
    await paths.ensureLayout(["mcp"]);
    const path = await paths.assertSafeDerivedFile(".video/mcp/broker.json");
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, projectDirectory, url: this.#url, token }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    this.#broker = { directory: projectDirectory, path, sessionId };
  }

  async #removeBroker(): Promise<void> {
    const broker = this.#broker;
    if (!broker) return;
    this.revokeSession(broker.sessionId);
    this.#broker = null;
    await rm(broker.path, { force: true }).catch(() => undefined);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.#authorizedSession(request, response);
    if (!session) return;
    try {
      await this.#serveRequest(session, request, response);
    } catch (error) {
      this.#writeRequestError(response, error);
    }
  }

  #authorizedSession(request: IncomingMessage, response: ServerResponse): AgentToolSession | null {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return null;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const session = this.#sessionsByToken.get(token);
    if (!session) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid agent session credential" }));
      return null;
    }
    return session;
  }

  async #serveRequest(
    session: AgentToolSession,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const server = this.#createMcpServer(session);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    response.once("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, body);
  }

  #writeRequestError(response: ServerResponse, error: unknown): void {
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32_603, message: error instanceof Error ? error.message : String(error) },
        id: null,
      }),
    );
  }

  #createMcpServer(session: AgentToolSession): McpServer {
    const server = new McpServer({ name: "cinesim", version: "0.1.0" });
    const requireProject = () => {
      if (this.projectStore.directory !== session.projectDirectory || !this.projectStore.project)
        throw new Error("The project attached to this agent is no longer open");
      return this.projectStore.project;
    };
    const runtime: CinesimMcpToolRuntime = {
      project: requireProject,
      program: () => this.projectStore.session().program,
      editMap: () => this.projectStore.session().editMap,
      directory: () => session.projectDirectory,
      projectRevision: () => this.projectStore.session().revision,
      projectStatus: async () => {
        const current = this.projectStore.session();
        const visualIndexes = await this.projectStore.visualIndex.status();
        return {
          acceptedGeneration: current.generation,
          diskValid: current.diskValid,
          candidateDiagnostics: current.candidateDiagnostics.slice(0, 20),
          diagnosticsTruncated: current.candidateDiagnostics.length > 20,
          lastValidComposition: current.project.activeSequenceId,
          backgroundJobs: this.projectStore.derivedMedia.snapshot().jobs,
          visualIndexes,
          exportJobs: this.projectStore.exports.status(),
        };
      },
      languageSearch: async (query, limit) =>
        searchLanguageReference(query, limit) as unknown as Record<string, unknown>[],
      exportCapabilities: async () => ({
        ...this.projectStore.exports.capabilities(),
        rendererAvailable: true,
      }),
      exportStart: async (request) => ({
        job: await this.projectStore.exports.start({
          presetId: request.presetId,
          ...(request.sequenceId ? { sequenceId: request.sequenceId } : {}),
          ...(request.fileName ? { fileName: request.fileName } : {}),
          ...(request.startUs === undefined ? {} : { startUs: timeUs(request.startUs) }),
          ...(request.endUs === undefined ? {} : { endUs: timeUs(request.endUs) }),
        }),
      }),
      exportStatus: async (jobId) => ({ jobs: this.projectStore.exports.status(jobId) }),
      exportCancel: async (jobId) => ({ job: await this.projectStore.exports.cancel(jobId) }),
      transcriptGet: async (assetId, fromUs, toUs, limit, observationId) => {
        const observationRange = observationId
          ? await this.projectStore.visualIndex.observationRange(assetId, observationId)
          : null;
        const selectedFromUs = observationRange?.sourceInUs ?? fromUs;
        const selectedToUs = observationRange?.sourceOutUs ?? toUs;
        const snapshot = await this.projectStore.transcripts.snapshot(
          this.projectStore.derivedMedia.scope(),
          [assetId],
        );
        const record = snapshot.assets[assetId as `asset_${string}`];
        const endUs = rangeEnd(selectedFromUs, selectedToUs);
        const matching = (record?.artifact?.words ?? []).filter(
          (word) => word.sourceEndUs > selectedFromUs && word.sourceStartUs < endUs,
        );
        return {
          assetId,
          state: record?.state ?? "missing",
          ...(record?.failureCode ? { failureCode: record.failureCode } : {}),
          ...(observationId ? { observationId } : {}),
          ...(record?.artifact
            ? {
                language: record.artifact.language,
                sourceFingerprint: record.artifact.sourceFingerprint,
                words: matching.slice(0, limit),
                truncated: matching.length > limit,
              }
            : {}),
        };
      },
      timelineTranscriptGet: async (sequenceId, fromUs, toUs, limit) => {
        const project = requireProject();
        const selectedSequenceId = sequenceId ?? project.activeSequenceId;
        const sequence = project.sequences.find((candidate) => candidate.id === selectedSequenceId);
        if (!sequence) throw new Error(`Unknown timeline: ${selectedSequenceId}`);
        const assetIds = [
          ...new Set(sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId))),
        ];
        const transcripts = await this.projectStore.transcripts.snapshot(
          this.projectStore.derivedMedia.scope(),
          assetIds,
        );
        const endUs = rangeEnd(fromUs, toUs);
        const projection = projectTimelineTranscript({
          project,
          sequenceId: selectedSequenceId,
          transcripts,
        });
        const matching = projection.words.filter(
          (word) => word.timelineEndUs > fromUs && word.timelineStartUs < endUs,
        );
        return {
          sequenceId: selectedSequenceId,
          words: matching.slice(0, limit),
          coverage: projection.coverage,
          truncated: matching.length > limit,
        };
      },
      transcriptJobs: async (action, assetIds) => {
        const scope = this.projectStore.derivedMedia.scope();
        const snapshot =
          action === "generate"
            ? await this.projectStore.transcripts.requestJobs(scope, assetIds)
            : action === "regenerate"
              ? await this.projectStore.transcripts.regenerateJobs(scope, assetIds)
              : await this.projectStore.transcripts.cancelJobs(scope, assetIds);
        return transcriptStates(snapshot);
      },
      visualIndexStatus: async (assetIds) => ({
        assets: await this.projectStore.visualIndex.status(assetIds),
      }),
      visualIndexGet: async (assetId, fromUs, toUs, limit) =>
        this.projectStore.visualIndex.get(assetId, {
          fromUs,
          ...(toUs === undefined ? {} : { toUs }),
          limit,
        }),
      visualIndexGenerate: async (action, assetIds) => ({
        assets: await this.projectStore.generateVisualIndex(assetIds, action === "regenerate"),
      }),
      visualIndexUpsert: async (assetId, observations) => ({
        asset: await this.projectStore.visualIndex.upsert(assetId, observations),
      }),
      visualIndexDelete: async (assetId, selector) => ({
        asset: await this.projectStore.visualIndex.delete(assetId, selector),
      }),
      visualIndexClear: async (assetIds) => ({
        assets: await this.projectStore.visualIndex.clear(assetIds),
      }),
      visualIndexObservationRange: (assetId, observationId) =>
        this.projectStore.visualIndex.observationRange(assetId, observationId),
      frameGet: async (target, atUs, quality) => ({
        ...(await this.projectStore.frames.get(target, atUs, quality)),
      }),
      perform: async (tool, operation) => {
        if (session.external) return jsonResult(await operation());
        const eventId = await this.hooks.onToolStarted(session.sessionId, tool.name, tool.detail);
        try {
          if (
            tool.mutating &&
            session.permissionMode === "supervised" &&
            !(await this.hooks.requestApproval(session.sessionId, tool.name, tool.detail))
          ) {
            throw new Error("The user declined this Cinesim edit");
          }
          const result = await operation();
          await this.hooks.onToolCompleted(
            session.sessionId,
            eventId,
            tool.name,
            "summary" in result && typeof result.summary === "string"
              ? result.summary
              : "Completed",
          );
          return jsonResult(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.hooks.onToolCompleted(session.sessionId, eventId, tool.name, message, true);
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      },
      derivedFile: async (relativePath) => {
        const paths = await ProjectPaths.open(session.projectDirectory);
        const path = await paths.assertSafeDerivedFile(relativePath);
        return localDerivedFile(path);
      },
    };
    registerCinesimMcpTools(server, runtime);
    return server;
  }
}

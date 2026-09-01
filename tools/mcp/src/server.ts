import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCinesimLogger } from "@cinesim/logging";
import { localDerivedFile, registerCinesimMcpTools } from "@cinesim/mcp-tools";
import type { CinesimMcpToolRuntime } from "@cinesim/mcp-tools";
import { parseProjectManifest, ProjectPaths } from "@cinesim/project-io";
import { DiskProjectStore } from "@cinesim/cli/project-store";

const log = createCinesimLogger({ service: "mcp" });

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
  const server = new McpServer({ name: "cinesim", version: "0.1.0" });
  const toolContext = new AsyncLocalStorage<DiskProjectStore>();
  const projectPaths = await ProjectPaths.open(projectDirectory);
  const store = (): DiskProjectStore => {
    const current = toolContext.getStore();
    if (!current) throw new Error("Project tool context is not loaded");
    return current;
  };
  const runtime: CinesimMcpToolRuntime = {
    project: () => store().project,
    program: () => store().program,
    editMap: () => store().editMap,
    directory: () => projectDirectory,
    projectStatus: async () => {
      try {
        const loaded = await new DiskProjectStore(projectDirectory).load();
        return {
          acceptedGeneration: loaded.generation,
          diskValid: true,
          candidateDiagnostics: [],
          diagnosticsTruncated: false,
          lastValidComposition: loaded.project.activeSequenceId,
          backgroundJobs: null,
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
    perform: async (tool, operation) => {
      try {
        if (tool.name === "project_status") return textResult(await operation());
        const loaded = await new DiskProjectStore(projectDirectory).load();
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

#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localDerivedFile, registerCinesimMcpTools } from "@cinesim/mcp-tools";
import type { CinesimMcpToolRuntime } from "@cinesim/mcp-tools";
import { createCinesimLogger } from "@cinesim/logging";
import { ProjectPaths } from "@cinesim/project-io";
import { DiskProjectStore } from "@cinesim/cli/project-store";

const projectDirectory = process.env.CINESIM_PROJECT ?? process.cwd();
const server = new McpServer({ name: "cinesim", version: "0.1.0" });
const log = createCinesimLogger({ service: "mcp" });

const textResult = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const failure = (error: unknown) => {
  log.error({ err: error }, "MCP operation failed");
  return {
    isError: true,
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
    ],
  };
};

let projectPaths: ProjectPaths | null = null;
const toolContext = new AsyncLocalStorage<DiskProjectStore>();

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
  perform: async (_tool, operation) => {
    try {
      const loaded = await new DiskProjectStore(projectDirectory).load();
      projectPaths ??= await ProjectPaths.open(projectDirectory);
      return textResult(await toolContext.run(loaded, operation));
    } catch (error) {
      return failure(error);
    }
  },
  derivedFile: async (relativePath) => {
    const paths = projectPaths ?? (projectPaths = await ProjectPaths.open(projectDirectory));
    const path = await paths.assertSafeDerivedFile(relativePath);
    return localDerivedFile(path);
  },
};

registerCinesimMcpTools(server, runtime);
await server.connect(new StdioServerTransport());

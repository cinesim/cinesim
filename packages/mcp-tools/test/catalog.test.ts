import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createProject } from "@cinesim/core";
import type { SemanticEditorCommand } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import {
  CINESIM_MCP_COMMAND_SUPPORT,
  CINESIM_MCP_TOOL_NAMES,
  registerCinesimMcpTools,
} from "../src";

const textResult = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

describe("canonical Cinesim MCP catalog", () => {
  it("registers one complete catalog and translates newer commands", async () => {
    const commands: SemanticEditorCommand[] = [];
    const project = createProject({ name: "Tool catalog" });
    const server = new McpServer({ name: "catalog-test", version: "0.1.0" });
    registerCinesimMcpTools(server, {
      project: () => project,
      directory: () => "/project",
      execute: async (command) => {
        commands.push(command);
        return { summary: command.type, changedIds: [], createdIds: [] };
      },
      perform: async (_tool, operation) => textResult(await operation()),
      derivedFile: async (relativePath) => ({ path: `/project/${relativePath}`, exists: false }),
    });
    const client = new Client({ name: "catalog-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...CINESIM_MCP_TOOL_NAMES].sort());
    await client.callTool({
      name: "clip_fade",
      arguments: { clipId: "clip_fixture", edge: "out", durationUs: 250_000 },
    });
    await client.callTool({
      name: "property_set",
      arguments: {
        nodeId: "clip_fixture",
        property: "opacity",
        value: { kind: "number", value: 0.5 },
      },
    });
    await client.callTool({
      name: "timeline_delete_ranges",
      arguments: {
        sequenceId: project.activeSequenceId,
        ranges: [{ startUs: 0, endUs: 1_000_000 }],
        mode: "ripple",
      },
    });
    expect(commands).toEqual([
      {
        type: "clip.setFade",
        clipId: "clip_fixture",
        edge: "out",
        durationUs: 250_000,
      },
      {
        type: "property.set",
        nodeId: "clip_fixture",
        property: "opacity",
        value: { kind: "number", value: 0.5 },
      },
      {
        type: "sequence.deleteRanges",
        sequenceId: project.activeSequenceId,
        ranges: [{ startUs: 0, endUs: 1_000_000 }],
        mode: "ripple",
      },
    ]);
    await client.close();
    await server.close();
  });

  it("rejects traversal-shaped IDs before a tool runtime is called", async () => {
    let operations = 0;
    const project = createProject({ name: "Tool validation" });
    const server = new McpServer({ name: "validation-test", version: "0.1.0" });
    registerCinesimMcpTools(server, {
      project: () => project,
      directory: () => "/project",
      execute: async () => ({ summary: "unexpected", changedIds: [], createdIds: [] }),
      perform: async (_tool, operation) => {
        operations += 1;
        return textResult(await operation());
      },
      derivedFile: async (relativePath) => ({ path: relativePath, exists: false }),
    });
    const client = new Client({ name: "validation-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await expect(
      client.callTool({
        name: "filmstrip_get",
        arguments: { assetId: "asset_../../outside" },
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      client.callTool({ name: "asset_inspect", arguments: { assetId: "asset_" } }),
    ).resolves.toMatchObject({ isError: true });
    expect(operations).toBe(0);
    await client.close();
    await server.close();
  });

  it("makes every canonical command either supported or explicitly unsupported", () => {
    expect(Object.keys(CINESIM_MCP_COMMAND_SUPPORT)).toHaveLength(22);
    expect(
      Object.entries(CINESIM_MCP_COMMAND_SUPPORT)
        .filter(([, support]) => support.kind === "unsupported")
        .map(([type]) => type),
    ).toEqual(["asset.import", "asset.setSource"]);
  });
});

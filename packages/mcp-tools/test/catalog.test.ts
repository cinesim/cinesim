import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createProject, projectToIr } from "../../core/test/project-fixtures";
import { describe, expect, it } from "vite-plus/test";
import { CINESIM_MCP_TOOL_NAMES, registerCinesimMcpTools } from "../src";

const FORBIDDEN_CANONICAL_TOOLS = [
  "asset_delete",
  "timeline_create_from_assets",
  "timeline_delete",
  "timeline_delete_ranges",
  "track_add",
  "track_update",
  "track_reorder",
  "track_delete",
  "clip_add",
  "clip_move",
  "clip_slip",
  "clip_duplicate",
  "clip_link",
  "clip_unlink",
  "clip_trim",
  "clip_fade",
  "clip_split",
  "clip_delete",
  "property_set",
] as const;

const textResult = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

function catalogServer(onOperation: () => void = () => undefined): McpServer {
  const project = createProject({ name: "Tool catalog" });
  const server = new McpServer({ name: "catalog-test", version: "0.1.0" });
  registerCinesimMcpTools(server, {
    project: () => project,
    program: () => projectToIr(project),
    editMap: () => ({ version: 2, entry: "main.jsx", sources: [], nodes: {} }),
    directory: () => "/project",
    projectStatus: async () => ({
      acceptedGeneration: "a".repeat(64),
      diskValid: true,
      candidateDiagnostics: [],
      lastValidComposition: project.activeSequenceId,
    }),
    languageSearch: async (query) => [
      {
        id: "recipe:fixture",
        kind: "recipe",
        title: "Fixture recipe",
        summary: query,
        capability: { compiler: "supported", preview: "supported", export: "unsupported" },
      },
    ],
    transcriptGet: async (assetId) => ({ assetId, state: "missing", words: [] }),
    timelineTranscriptGet: async (sequenceId) => ({
      sequenceId: sequenceId ?? project.activeSequenceId,
      words: [],
    }),
    transcriptJobs: async (action, assetIds) => ({ action, assetIds }),
    visualIndexStatus: async (assetIds) => ({ assetIds: assetIds ?? [], state: "current" }),
    visualIndexGet: async (assetId, fromUs, toUs, limit) => ({
      assetId,
      fromUs,
      toUs,
      limit,
      observations: [],
    }),
    visualIndexGenerate: async (action, assetIds) => ({ action, assetIds }),
    visualIndexUpsert: async (assetId, observations) => ({ assetId, observations }),
    visualIndexDelete: async (assetId, selector) => ({ assetId, selector }),
    visualIndexClear: async (assetIds) => ({ assetIds }),
    visualIndexObservationRange: async () => ({ sourceInUs: 0, sourceOutUs: 1_000_000 }),
    perform: async (_tool, operation) => {
      onOperation();
      return textResult(await operation());
    },
    derivedFile: async (relativePath) => ({ path: `/project/${relativePath}`, exists: false }),
  });
  return server;
}

async function connectedCatalog() {
  const server = catalogServer();
  const client = new Client({ name: "catalog-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("Cinesim inspection and perception MCP catalog", () => {
  it("lists only the explicit noncanonical catalog and serves inspection", async () => {
    const { client, server } = await connectedCatalog();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...CINESIM_MCP_TOOL_NAMES].sort());
    expect(tools.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([...FORBIDDEN_CANONICAL_TOOLS]),
    );
    await expect(
      client.callTool({ name: "project_inspect", arguments: {} }),
    ).resolves.toMatchObject({ structuredContent: { version: 2 } });
    await expect(
      client.callTool({ name: "language_search", arguments: { query: "cutaway", limit: 4 } }),
    ).resolves.toMatchObject({
      structuredContent: {
        query: "cutaway",
        results: [expect.objectContaining({ id: "recipe:fixture" })],
      },
    });
    await expect(
      client.callTool({
        name: "visual_index_upsert",
        arguments: {
          assetId: "asset_fixture",
          observations: [
            {
              id: "observation_opening",
              sourceInUs: 0,
              sourceOutUs: 1_000_000,
              description: "Opening image",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      structuredContent: { observations: [expect.objectContaining({ id: "observation_opening" })] },
    });
    await expect(
      client.callTool({
        name: "frame_get",
        arguments: { assetId: "asset_fixture", observationId: "observation_opening" },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        atUs: 500_000,
        observationId: "observation_opening",
        path: "/project/.video/frames/asset_fixture-500000.png",
      },
    });
    await client.close();
    await server.close();
  });

  it("does not register or call any former canonical editing tool", async () => {
    const { client, server } = await connectedCatalog();
    for (const name of FORBIDDEN_CANONICAL_TOOLS) {
      await expect(client.callTool({ name, arguments: {} })).resolves.toMatchObject({
        isError: true,
      });
    }
    await client.close();
    await server.close();
  });

  it("rejects traversal-shaped IDs before a runtime operation", async () => {
    let operations = 0;
    const server = catalogServer(() => {
      operations += 1;
    });
    const client = new Client({ name: "validation-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await expect(
      client.callTool({ name: "filmstrip_get", arguments: { assetId: "asset_../../outside" } }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      client.callTool({ name: "asset_inspect", arguments: { assetId: "asset_" } }),
    ).resolves.toMatchObject({ isError: true });
    expect(operations).toBe(0);
    await client.close();
    await server.close();
  });
});

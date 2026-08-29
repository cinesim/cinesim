import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CINESIM_MCP_TOOL_NAMES } from "@cinesim/mcp-tools";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AgentMcpServer } from "../src/main/agents/mcp/server";
import { DesktopProjectStore } from "../src/main/projects/project-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("AgentMcpServer", () => {
  it("serves project tools through a scoped bearer credential", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cinesim-agent-mcp-"));
    temporaryDirectories.push(parent);
    const projectStore = new DesktopProjectStore();
    const project = await projectStore.create(parent, "MCP project");
    await projectStore.execute({
      type: "asset.import",
      asset: {
        id: "asset_fixture",
        kind: "video",
        name: "Fixture",
        source: { kind: "local", path: join(parent, "fixture.mov") },
        durationUs: 2_000_000,
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: false,
      },
    });
    const approvals: string[] = [];
    const server = new AgentMcpServer(projectStore, {
      onToolStarted: async () => crypto.randomUUID(),
      onToolCompleted: async () => undefined,
      requestApproval: async (_sessionId, toolName) => {
        approvals.push(toolName);
        return false;
      },
      onProjectChanged: () => undefined,
    });
    await server.start();
    const credential = server.registerSession({
      sessionId: "session-1",
      projectDirectory: project.directory,
      permissionMode: "supervised",
    });
    const client = new Client({ name: "cinesim-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(credential.url), {
      requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
    });
    await client.connect(transport as Parameters<typeof client.connect>[0]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...CINESIM_MCP_TOOL_NAMES].sort());
    const inspection = await client.callTool({ name: "project_inspect", arguments: {} });
    expect(inspection.isError).not.toBe(true);
    const denied = await client.callTool({
      name: "clip_add",
      arguments: {
        trackId: project.project.sequences[0]!.tracks[0]!.id,
        assetId: "asset_fixture",
        timelineStartUs: 0,
      },
    });
    expect(denied.isError).toBe(true);
    expect(approvals).toEqual(["clip_add"]);
    await expect(
      client.callTool({
        name: "filmstrip_get",
        arguments: { assetId: "asset_../../outside" },
      }),
    ).resolves.toMatchObject({ isError: true });

    await client.close();

    const automaticCredential = server.registerSession({
      sessionId: "session-2",
      projectDirectory: project.directory,
      permissionMode: "auto-edit",
    });
    const automaticClient = new Client({ name: "cinesim-test-auto", version: "0.1.0" });
    const automaticTransport = new StreamableHTTPClientTransport(new URL(automaticCredential.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${automaticCredential.token}` },
      },
    });
    await automaticClient.connect(
      automaticTransport as Parameters<typeof automaticClient.connect>[0],
    );
    const edited = await automaticClient.callTool({
      name: "clip_add",
      arguments: {
        trackId: project.project.sequences[0]!.tracks[0]!.id,
        assetId: "asset_fixture",
        timelineStartUs: 0,
      },
    });
    expect(edited.isError).not.toBe(true);
    expect(projectStore.project?.sequences[0]?.tracks[0]?.clips).toHaveLength(1);

    await automaticClient.close();
    await server.close();
  });
});

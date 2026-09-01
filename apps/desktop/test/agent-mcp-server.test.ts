import { timeUs } from "@cinesim/core";
import { access, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        durationUs: timeUs(2_000_000),
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
    const brokerPath = join(project.directory, ".video", "mcp", "broker.json");
    const broker = JSON.parse(await readFile(brokerPath, "utf8")) as {
      url: string;
      token: string;
      projectDirectory: string;
    };
    expect(broker).toMatchObject({
      projectDirectory: project.directory,
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u),
      token: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect((await lstat(brokerPath)).mode & 0o077).toBe(0);
    const externalClient = new Client({ name: "external-cinesim-test", version: "0.1.0" });
    await externalClient.connect(
      new StreamableHTTPClientTransport(new URL(broker.url), {
        requestInit: { headers: { Authorization: `Bearer ${broker.token}` } },
      }) as Parameters<typeof externalClient.connect>[0],
    );
    await expect(externalClient.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "project_status" })]),
    });
    await externalClient.close();
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
    await expect(client.callTool({ name: "project_status", arguments: {} })).resolves.toMatchObject(
      {
        structuredContent: {
          acceptedGeneration: projectStore.session().generation,
          diskValid: true,
          candidateDiagnostics: [],
          lastValidComposition: project.project.activeSequenceId,
        },
      },
    );

    const invalidCandidate = new Promise<void>((resolve) => {
      const unsubscribe = projectStore.subscribe((session) => {
        if (session.diskValid) return;
        unsubscribe();
        resolve();
      });
    });
    await writeFile(join(project.directory, "main.jsx"), "export const main = <composition");
    await invalidCandidate;
    const invalidStatus = await client.callTool({ name: "project_status", arguments: {} });
    expect(invalidStatus).toMatchObject({
      structuredContent: {
        acceptedGeneration: projectStore.session().generation,
        diskValid: false,
        candidateDiagnostics: [expect.objectContaining({ severity: "error" })],
        lastValidComposition: project.project.activeSequenceId,
      },
    });
    const unavailableEdit = await client.callTool({
      name: "clip_add",
      arguments: {},
    });
    expect(unavailableEdit.isError).toBe(true);
    expect(approvals).toEqual([]);
    expect(projectStore.project?.sequences[0]?.tracks[0]?.clips).toHaveLength(0);
    await expect(
      client.callTool({
        name: "filmstrip_get",
        arguments: { assetId: "asset_../../outside" },
      }),
    ).resolves.toMatchObject({ isError: true });

    await client.close();

    await server.close();
    await expect(access(brokerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await projectStore.close();
  });
});

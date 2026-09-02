import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AgentManager } from "../src/main/agents/manager";
import { AgentSettingsStore } from "../src/main/agents/settings-store";
import { DesktopProjectStore } from "../src/main/projects/project-store";
import type { AgentSessionSnapshot } from "../src/shared/contracts";

const temporaryDirectories: string[] = [];
const managers: AgentManager[] = [];
const projectStores: DesktopProjectStore[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const store of projectStores.splice(0)) await store.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function harness(providerSource: string) {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-turn-"));
  temporaryDirectories.push(directory);
  const executablePath = join(directory, "claude");
  await writeFile(executablePath, `#!/usr/bin/env node\n${providerSource}`);
  await chmod(executablePath, 0o755);

  const projectStore = new DesktopProjectStore();
  projectStores.push(projectStore);
  const project = await projectStore.create(directory, "Agent turn project");
  const settings = new AgentSettingsStore(join(directory, "agent-settings.json"));
  await settings.load();
  await settings.trustExecutable("claude", executablePath);
  const manager = new AgentManager(
    join(directory, "agent-sessions.json"),
    settings,
    projectStore,
    () => undefined,
    () => undefined,
  );
  managers.push(manager);
  await manager.load();
  const created = await manager.create({ projectDirectory: project.directory, provider: "claude" });
  return { manager, projectDirectory: project.directory, sessionId: created.activeSessionId! };
}

async function waitForSession(
  manager: AgentManager,
  projectDirectory: string,
  predicate: (session: AgentSessionSnapshot) => boolean,
): Promise<AgentSessionSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = manager.snapshot(projectDirectory).sessions[0]!;
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for agent session state");
}

describe("agent turn lifecycle", () => {
  it("records one clean completed terminal event without project-change summaries", async () => {
    const { manager, projectDirectory, sessionId } = await harness(`
const readline = require("node:readline");
const send = value => console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on("line", () => {
  send({type:"stream_event",event:{type:"message_start"}});
  send({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"Done"}}});
  send({type:"result",subtype:"success"});
});`);

    await manager.send(sessionId, "Make a vlog");
    const session = await waitForSession(
      manager,
      projectDirectory,
      (candidate) => candidate.status === "completed",
    );
    expect(session.status).toBe("completed");
    expect(session.events.filter((event) => event.kind === "turn-result")).toEqual([
      expect.objectContaining({ status: "completed", title: "Turn completed" }),
    ]);
    expect(session.events.some((event) => (event.kind as string) === "checkpoint")).toBe(false);
  });

  it("normalizes a user stop and late provider failure into one interrupted result", async () => {
    const { manager, projectDirectory, sessionId } = await harness(`
const readline = require("node:readline");
const send = value => console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on("line", () => {
  send({type:"stream_event",event:{type:"message_start"}});
  send({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"Working"}}});
});
process.on("SIGINT", () => {
  send({type:"result",subtype:"error",errors:["late provider failure"]});
  setTimeout(() => process.exit(1), 10);
});`);

    await manager.send(sessionId, "Make a vlog");
    await manager.interrupt(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const session = manager.snapshot(projectDirectory).sessions[0]!;
    expect(session.status).toBe("interrupted");
    expect(session.events.filter((event) => event.kind === "turn-result")).toEqual([
      expect.objectContaining({ status: "interrupted", title: "Interrupted by user" }),
    ]);
    expect(
      session.events.some((event) => event.kind === "turn-result" && event.status === "failed"),
    ).toBe(false);
  });
});

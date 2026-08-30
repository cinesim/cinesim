import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AgentApprovalBroker } from "../src/main/agents/approval-broker";
import { AgentSessionStore } from "../src/main/agents/session-store";
import type { PersistedAgentState } from "../src/main/agents/session-store";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function stateFixture(): PersistedAgentState {
  const timestamp = "2026-08-30T12:00:00.000Z";
  return {
    version: 1,
    activeSessionByProject: { "/project": "session-fixture" },
    sessions: [
      {
        id: "session-fixture",
        projectDirectory: "/project",
        provider: "codex",
        model: "gpt-5",
        effort: "high",
        permissionMode: "supervised",
        title: "Fixture",
        status: "idle",
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [],
        checkpoints: [],
      },
    ],
  };
}

describe("agent state safety", () => {
  it("strictly validates persisted state while migrating the v1 effort field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-state-"));
    directories.push(directory);
    const path = join(directory, "sessions.json");
    const legacy = stateFixture() as unknown as { sessions: Array<Record<string, unknown>> };
    delete legacy.sessions[0]!.effort;
    await writeFile(path, JSON.stringify(legacy));
    const store = new AgentSessionStore(path);
    expect((await store.read({ claude: "medium", codex: "xhigh" })).sessions[0]?.effort).toBe(
      "xhigh",
    );

    await writeFile(path, JSON.stringify({ ...stateFixture(), unexpected: true }));
    await expect(store.read({ claude: "medium", codex: "high" })).rejects.toThrow();
  });

  it("serializes concurrent state writes through unique atomic files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-state-"));
    directories.push(directory);
    const path = join(directory, "sessions.json");
    const store = new AgentSessionStore(path);
    const first = stateFixture();
    const second = stateFixture();
    second.sessions[0]!.title = "Second";
    await Promise.all([store.write(first), store.write(second)]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      sessions: [{ title: "Second" }],
    });
  });

  it("binds approval leases to their session and turn and expires them", async () => {
    vi.useFakeTimers();
    const broker = new AgentApprovalBroker(100);
    let expired = false;
    const { lease, decision } = broker.request({
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "project_edit",
      detail: "Move clip",
      expired: () => {
        expired = true;
      },
    });
    expect(() => broker.intent("session-1", lease.requestId, "turn-2")).toThrow(/no longer active/);
    await expect(decision).resolves.toBe(false);
    expect(expired).toBe(true);
  });
});

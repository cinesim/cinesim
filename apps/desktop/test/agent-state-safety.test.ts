import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AgentSessionStore } from "../src/main/agents/session-store";
import type { PersistedAgentState } from "../src/main/agents/session-store";
import {
  CODEX_REQUEST_TIMEOUT_MS,
  PROVIDER_DETECTION_MAX_OUTPUT_BYTES,
  PROVIDER_DETECTION_TIMEOUT_MS,
} from "../src/main/agents/runtime-policy";

const directories: string[] = [];

afterEach(async () => {
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
        title: "Fixture",
        status: "idle",
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [],
      },
    ],
  };
}

describe("agent state safety", () => {
  it("owns bounded provider detection and request timeout policy", () => {
    expect(PROVIDER_DETECTION_TIMEOUT_MS).toBe(8_000);
    expect(PROVIDER_DETECTION_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
    expect(CODEX_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("strictly validates persisted state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-state-"));
    directories.push(directory);
    const path = join(directory, "sessions.json");
    const missingEffort = stateFixture() as unknown as { sessions: Array<Record<string, unknown>> };
    delete missingEffort.sessions[0]!.effort;
    await writeFile(path, JSON.stringify(missingEffort));
    const store = new AgentSessionStore(path);
    await expect(store.read()).rejects.toThrow();

    await writeFile(path, JSON.stringify({ ...stateFixture(), unexpected: true }));
    await expect(store.read()).rejects.toThrow();
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

  it("migrates obsolete approval and checkpoint state out of persisted sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-state-"));
    directories.push(directory);
    const path = join(directory, "sessions.json");
    const legacy = stateFixture() as unknown as {
      sessions: Array<Record<string, unknown> & { events: unknown[] }>;
    };
    legacy.sessions[0]!.permissionMode = "supervised";
    legacy.sessions[0]!.checkpoints = [];
    legacy.sessions[0]!.status = "waiting";
    legacy.sessions[0]!.activeTurnId = "legacy-turn";
    legacy.sessions[0]!.events = [
      {
        id: "legacy-approval",
        sessionId: "session-fixture",
        kind: "approval-requested",
        createdAt: "2026-08-30T12:00:00.000Z",
        requestId: "request-1",
        status: "running",
      },
    ];
    await writeFile(path, JSON.stringify(legacy));

    const migrated = await new AgentSessionStore(path).read();
    expect(migrated.sessions[0]).not.toHaveProperty("permissionMode");
    expect(migrated.sessions[0]).not.toHaveProperty("checkpoints");
    expect(migrated.sessions[0]).toMatchObject({ status: "interrupted" });
    expect(migrated.sessions[0]?.activeTurnId).toBeUndefined();
    expect(migrated.sessions[0]?.events).toEqual([]);
  });
});

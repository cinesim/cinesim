import { describe, expect, it } from "vite-plus/test";
import { AgentSessionEvents } from "../src/main/agents/session-events";
import type { AgentSessionSnapshot } from "../src/shared/contracts";
import {
  formatRunningDuration,
  formatTurnDuration,
  turnStartedAt,
} from "../src/renderer/components/agents/agent-event-format";

function sessionFixture(): AgentSessionSnapshot {
  return {
    id: "session-1",
    projectDirectory: "/project",
    provider: "codex",
    model: "gpt-5",
    effort: "high",
    title: "Fixture",
    status: "working",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    activeTurnId: "turn-1",
    events: [
      {
        id: "user-1",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "user-message",
        createdAt: "2026-09-01T12:00:00.000Z",
        text: "Make a vlog",
      },
    ],
  };
}

describe("agent conversation presentation", () => {
  it("formats running and terminal turn durations from the initiating message", () => {
    const session = sessionFixture();
    const startedAt = turnStartedAt(session, "turn-1");
    expect(startedAt).toBe(Date.parse("2026-09-01T12:00:00.000Z"));
    expect(formatRunningDuration(startedAt, startedAt + 10_240)).toBe("10.2s");
    expect(formatTurnDuration(startedAt, startedAt + 1_001)).toBe("2s");
    expect(formatTurnDuration(startedAt, startedAt)).toBe("1s");
  });

  it("coalesces provider tool lifecycle events into one inline row", () => {
    const session = sessionFixture();
    const events = new AgentSessionEvents();
    events.prepareLoaded(session);
    events.appendRuntime(session, {
      kind: "tool-started",
      toolName: "commandExecution",
      title: "commandExecution",
      detail: "vp test",
      status: "running",
    });
    events.appendRuntime(session, {
      kind: "tool-completed",
      toolName: "commandExecution",
      title: "commandExecution",
      detail: "vp test",
      status: "completed",
    });

    expect(session.events.filter((event) => event.toolName === "commandExecution")).toEqual([
      expect.objectContaining({ kind: "tool-completed", detail: "vp test", status: "completed" }),
    ]);
  });

  it("settles any still-running tool row when its turn terminates", () => {
    const session = sessionFixture();
    const events = new AgentSessionEvents();
    events.prepareLoaded(session);
    events.appendRuntime(session, {
      kind: "tool-started",
      toolName: "Read",
      title: "Read",
      detail: "assets.toml",
      status: "running",
    });
    events.completeRunningTools(session, "turn-1", false);

    expect(session.events.at(-1)).toMatchObject({ kind: "tool-completed", status: "completed" });
  });
});

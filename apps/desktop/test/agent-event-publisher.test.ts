import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  AgentProjectDelta,
  AgentProjectSnapshot,
  AgentSessionSnapshot,
} from "../src/shared/contracts";
import { AgentEventPublisher } from "../src/main/agents/event-publisher";
import { AgentStreamBatcher } from "../src/main/agents/stream-batcher";
import { applyAgentProjectDelta } from "../src/renderer/lib/agent-project-delta";

afterEach(() => vi.useRealTimers());

function sessionFixture(): AgentSessionSnapshot {
  const timestamp = "2026-08-30T12:00:00.000Z";
  return {
    id: "session-fixture",
    projectDirectory: "/project",
    provider: "codex",
    model: "gpt-5",
    effort: "high",
    title: "Long edit",
    status: "working",
    createdAt: timestamp,
    updatedAt: timestamp,
    activeTurnId: "turn-fixture",
    events: Array.from({ length: 600 }, (_, index) => ({
      id: `event-${index}`,
      sessionId: "session-fixture",
      turnId: "turn-fixture",
      kind: "assistant-message" as const,
      createdAt: timestamp,
      text: index === 599 ? "a".repeat(500_000) : `historical event ${index}`,
    })),
  };
}

function snapshotFixture(): AgentProjectSnapshot {
  return {
    projectDirectory: "/project",
    revision: 0,
    activeSessionId: "session-fixture",
    sessions: [sessionFixture()],
  };
}

describe("agent revisioned event publishing", () => {
  it("publishes an appended text fragment without cloning the complete history", () => {
    const deltas: AgentProjectDelta[] = [];
    const publisher = new AgentEventPublisher((delta) => deltas.push(delta));
    const previous = snapshotFixture();
    publisher.seed(previous);
    const next = structuredClone(previous);
    next.sessions[0]!.events.at(-1)!.text += " done";
    next.sessions[0]!.events.at(-1)!.createdAt = "2026-08-30T12:00:01.000Z";

    expect(publisher.publish(next)).toBe(1);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.operations).toContainEqual({
      type: "event-text-appended",
      sessionId: "session-fixture",
      eventId: "event-599",
      text: " done",
      createdAt: "2026-08-30T12:00:01.000Z",
    });
    expect(Buffer.byteLength(JSON.stringify(deltas[0]))).toBeLessThan(1_000);
    expect(
      applyAgentProjectDelta(previous, deltas[0]!)
        ?.sessions[0]?.events.at(-1)
        ?.text?.endsWith(" done"),
    ).toBe(true);
  });

  it("rejects a revision gap so the renderer can request a fresh snapshot", () => {
    const current = snapshotFixture();
    expect(
      applyAgentProjectDelta(current, {
        projectDirectory: current.projectDirectory,
        baseRevision: 2,
        revision: 3,
        operations: [],
      }),
    ).toBeNull();
  });

  it("batches high-frequency provider notifications to a named 25Hz cadence", async () => {
    vi.useFakeTimers();
    const batcher = new AgentStreamBatcher(40);
    let publications = 0;
    for (let index = 0; index < 10_000; index += 1)
      batcher.schedule("/project", () => {
        publications += 1;
      });
    expect(publications).toBe(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(publications).toBe(1);
    for (let index = 0; index < 10_000; index += 1)
      batcher.schedule("/project", () => {
        publications += 1;
      });
    await vi.advanceTimersByTimeAsync(960);
    expect(publications).toBe(2);
  });
});

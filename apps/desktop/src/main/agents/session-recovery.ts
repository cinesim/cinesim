import type { AgentSessionSnapshot } from "../../shared/contracts";
import type { AgentSessionEvents } from "./session-events";

function now(): string {
  return new Date().toISOString();
}

export function isAgentSessionBusy(session: AgentSessionSnapshot): boolean {
  return session.status === "starting" || session.status === "working";
}

export function recoverAgentSession(
  session: AgentSessionSnapshot,
  events: AgentSessionEvents,
): void {
  if (isAgentSessionBusy(session)) markInterrupted(session);
  events.prepareLoaded(session);
}

function markInterrupted(session: AgentSessionSnapshot): void {
  const turnId = session.activeTurnId;
  session.status = "interrupted";
  session.activeTurnId = undefined;
  session.events.push({
    id: crypto.randomUUID(),
    sessionId: session.id,
    kind: "turn-result",
    createdAt: now(),
    title: "Interrupted by user",
    detail: "Cinesim restarted while this agent was running. Send another message to resume.",
    status: "interrupted",
    ...(turnId ? { turnId } : {}),
  });
}

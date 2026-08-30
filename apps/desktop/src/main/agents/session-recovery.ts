import type { AgentSessionSnapshot } from "../../shared/contracts";
import type { AgentSessionEvents } from "./session-events";

function now(): string {
  return new Date().toISOString();
}

export function isAgentSessionBusy(session: AgentSessionSnapshot): boolean {
  return (
    session.status === "starting" || session.status === "working" || session.status === "waiting"
  );
}

export function recoverAgentSession(
  session: AgentSessionSnapshot,
  events: AgentSessionEvents,
): void {
  cancelLoadedApprovals(session);
  if (isAgentSessionBusy(session)) markInterrupted(session);
  events.prepareLoaded(session);
}

function cancelLoadedApprovals(session: AgentSessionSnapshot): void {
  const resolved = new Set(
    session.events
      .filter(({ kind }) => kind === "approval-resolved")
      .map(({ requestId }) => requestId),
  );
  const pending = session.events.filter(
    ({ kind, requestId }) => kind === "approval-requested" && requestId && !resolved.has(requestId),
  );
  for (const request of pending) {
    const requestId = request.requestId;
    if (!requestId) continue;
    session.events.push({
      id: crypto.randomUUID(),
      sessionId: session.id,
      kind: "approval-resolved",
      createdAt: now(),
      requestId,
      title: "Cancelled",
      status: "declined",
    });
  }
}

function markInterrupted(session: AgentSessionSnapshot): void {
  session.status = "interrupted";
  session.activeTurnId = undefined;
  session.events.push({
    id: crypto.randomUUID(),
    sessionId: session.id,
    kind: "notice",
    createdAt: now(),
    title: "Session interrupted",
    detail: "Cinesim restarted while this agent was running. Send another message to resume.",
  });
}

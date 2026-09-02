import type {
  AgentProjectDelta,
  AgentProjectDeltaOperation,
  AgentProjectSnapshot,
  AgentSessionSnapshot,
} from "../../shared/contracts";

function upsertSession(next: AgentProjectSnapshot, session: AgentSessionSnapshot): void {
  const index = next.sessions.findIndex((candidate) => candidate.id === session.id);
  if (index < 0) next.sessions.push(structuredClone(session));
  else next.sessions[index] = structuredClone(session);
}

function upsertEvent(
  session: AgentSessionSnapshot,
  operation: Extract<AgentProjectDeltaOperation, { type: "event-appended" | "event-patched" }>,
): void {
  const index = session.events.findIndex((event) => event.id === operation.event.id);
  if (index < 0) session.events.push(structuredClone(operation.event));
  else session.events[index] = structuredClone(operation.event);
}

function applySessionOperation(
  session: AgentSessionSnapshot,
  operation: Exclude<
    AgentProjectDeltaOperation,
    | { type: "project-reset" }
    | { type: "active-session-changed" }
    | { type: "session-created" }
    | { type: "session-removed" }
  >,
): boolean {
  switch (operation.type) {
    case "session-patched":
      Object.assign(session, operation.patch);
      return true;
    case "token-usage-changed":
      session.tokenUsage = operation.usage ?? undefined;
      return true;
    case "event-appended":
    case "event-patched":
      upsertEvent(session, operation);
      return true;
    case "event-text-appended": {
      const event = session.events.find((candidate) => candidate.id === operation.eventId);
      if (!event) return false;
      event.text = `${event.text ?? ""}${operation.text}`;
      event.createdAt = operation.createdAt;
      return true;
    }
    case "events-pruned": {
      const removed = new Set(operation.eventIds);
      session.events = session.events.filter((event) => !removed.has(event.id));
      return true;
    }
  }
}

function applyOperation(
  next: AgentProjectSnapshot,
  operation: AgentProjectDeltaOperation,
): boolean {
  switch (operation.type) {
    case "project-reset":
      return true;
    case "active-session-changed":
      next.activeSessionId = operation.sessionId;
      return true;
    case "session-created":
      upsertSession(next, operation.session);
      return true;
    case "session-removed":
      next.sessions = next.sessions.filter((session) => session.id !== operation.sessionId);
      return true;
    default: {
      const session = next.sessions.find((candidate) => candidate.id === operation.sessionId);
      return session ? applySessionOperation(session, operation) : false;
    }
  }
}

export function applyAgentProjectDelta(
  current: AgentProjectSnapshot | null,
  delta: AgentProjectDelta,
): AgentProjectSnapshot | null {
  const reset = delta.operations.find((operation) => operation.type === "project-reset");
  if (reset?.type === "project-reset") return structuredClone(reset.snapshot);
  if (
    !current ||
    current.projectDirectory !== delta.projectDirectory ||
    current.revision !== delta.baseRevision
  )
    return null;
  const next = structuredClone(current);
  for (const operation of delta.operations) if (!applyOperation(next, operation)) return null;
  next.revision = delta.revision;
  return next;
}

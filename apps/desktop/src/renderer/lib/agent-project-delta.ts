import type { AgentProjectDelta, AgentProjectSnapshot } from "../../shared/contracts";

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
  for (const operation of delta.operations) {
    if (operation.type === "project-reset") continue;
    if (operation.type === "active-session-changed") {
      next.activeSessionId = operation.sessionId;
      continue;
    }
    if (operation.type === "session-created") {
      const index = next.sessions.findIndex((session) => session.id === operation.session.id);
      if (index < 0) next.sessions.push(structuredClone(operation.session));
      else next.sessions[index] = structuredClone(operation.session);
      continue;
    }
    if (operation.type === "session-removed") {
      next.sessions = next.sessions.filter((session) => session.id !== operation.sessionId);
      continue;
    }
    const session = next.sessions.find((candidate) => candidate.id === operation.sessionId);
    if (!session) return null;
    if (operation.type === "session-patched") Object.assign(session, operation.patch);
    else if (operation.type === "token-usage-changed")
      session.tokenUsage = operation.usage ?? undefined;
    else if (operation.type === "event-appended" || operation.type === "event-patched") {
      const index = session.events.findIndex((event) => event.id === operation.event.id);
      if (index < 0) session.events.push(structuredClone(operation.event));
      else session.events[index] = structuredClone(operation.event);
    } else if (operation.type === "event-text-appended") {
      const event = session.events.find((candidate) => candidate.id === operation.eventId);
      if (!event) return null;
      event.text = `${event.text ?? ""}${operation.text}`;
      event.createdAt = operation.createdAt;
    } else if (operation.type === "events-pruned") {
      const removed = new Set(operation.eventIds);
      session.events = session.events.filter((event) => !removed.has(event.id));
    } else if (operation.type === "checkpoints-replaced") {
      session.checkpoints = structuredClone(operation.checkpoints);
    }
  }
  next.revision = delta.revision;
  return next;
}

import type {
  AgentProjectDelta,
  AgentProjectDeltaOperation,
  AgentProjectSnapshot,
  AgentSessionMetadataPatch,
  AgentSessionSnapshot,
} from "../../shared/contracts";

const SESSION_METADATA_KEYS = [
  "provider",
  "model",
  "effort",
  "permissionMode",
  "title",
  "status",
  "createdAt",
  "updatedAt",
  "providerSessionId",
  "activeTurnId",
] as const;

export class AgentEventPublisher {
  readonly #published = new Map<string, AgentProjectSnapshot>();
  readonly #revisions = new Map<string, number>();

  constructor(private readonly publishDelta: (delta: AgentProjectDelta) => void) {}

  revision(projectDirectory: string): number {
    return this.#revisions.get(projectDirectory) ?? 0;
  }

  seed(snapshot: AgentProjectSnapshot): void {
    if (this.#published.has(snapshot.projectDirectory)) return;
    this.#published.set(snapshot.projectDirectory, structuredClone(snapshot));
    this.#revisions.set(snapshot.projectDirectory, snapshot.revision);
  }

  publish(snapshot: AgentProjectSnapshot): number {
    const projectDirectory = snapshot.projectDirectory;
    const baseRevision = this.revision(projectDirectory);
    const previous = this.#published.get(projectDirectory);
    const operations = previous
      ? projectDeltaOperations(previous, snapshot)
      : [{ type: "project-reset", snapshot } satisfies AgentProjectDeltaOperation];
    if (operations.length === 0) return baseRevision;
    const revision = baseRevision + 1;
    const revisedSnapshot = { ...snapshot, revision };
    const revisedOperations = operations.map((operation) =>
      operation.type === "project-reset"
        ? ({ ...operation, snapshot: revisedSnapshot } satisfies AgentProjectDeltaOperation)
        : operation,
    );
    this.#revisions.set(projectDirectory, revision);
    this.#published.set(projectDirectory, structuredClone(revisedSnapshot));
    this.publishDelta({ projectDirectory, baseRevision, revision, operations: revisedOperations });
    return revision;
  }
}

function projectDeltaOperations(
  previous: AgentProjectSnapshot,
  next: AgentProjectSnapshot,
): AgentProjectDeltaOperation[] {
  const operations: AgentProjectDeltaOperation[] = [];
  if (previous.activeSessionId !== next.activeSessionId)
    operations.push({ type: "active-session-changed", sessionId: next.activeSessionId });
  const previousSessions = new Map(previous.sessions.map((session) => [session.id, session]));
  const nextSessions = new Map(next.sessions.map((session) => [session.id, session]));
  for (const session of previous.sessions) {
    if (!nextSessions.has(session.id))
      operations.push({ type: "session-removed", sessionId: session.id });
  }
  for (const session of next.sessions) {
    const prior = previousSessions.get(session.id);
    if (!prior) {
      operations.push({ type: "session-created", session: structuredClone(session) });
      continue;
    }
    operations.push(...sessionDeltaOperations(prior, session));
  }
  return operations;
}

function sessionDeltaOperations(
  previous: AgentSessionSnapshot,
  next: AgentSessionSnapshot,
): AgentProjectDeltaOperation[] {
  const operations: AgentProjectDeltaOperation[] = [];
  const patch: AgentSessionMetadataPatch = {};
  for (const key of SESSION_METADATA_KEYS) {
    if (previous[key] !== next[key]) Object.assign(patch, { [key]: next[key] });
  }
  if (Object.keys(patch).length > 0)
    operations.push({ type: "session-patched", sessionId: next.id, patch });
  if (JSON.stringify(previous.tokenUsage) !== JSON.stringify(next.tokenUsage))
    operations.push({
      type: "token-usage-changed",
      sessionId: next.id,
      usage: next.tokenUsage ? structuredClone(next.tokenUsage) : null,
    });

  const previousEvents = new Map(previous.events.map((event) => [event.id, event]));
  const nextEvents = new Map(next.events.map((event) => [event.id, event]));
  const pruned = previous.events
    .filter((event) => !nextEvents.has(event.id))
    .map((event) => event.id);
  if (pruned.length > 0)
    operations.push({ type: "events-pruned", sessionId: next.id, eventIds: pruned });
  for (const event of next.events) {
    const prior = previousEvents.get(event.id);
    if (!prior)
      operations.push({
        type: "event-appended",
        sessionId: next.id,
        event: structuredClone(event),
      });
    else if (JSON.stringify(prior) !== JSON.stringify(event)) {
      const appendedText = appendedEventText(prior, event);
      operations.push(
        appendedText === null
          ? { type: "event-patched", sessionId: next.id, event: structuredClone(event) }
          : {
              type: "event-text-appended",
              sessionId: next.id,
              eventId: event.id,
              text: appendedText,
              createdAt: event.createdAt,
            },
      );
    }
  }
  if (JSON.stringify(previous.checkpoints) !== JSON.stringify(next.checkpoints))
    operations.push({
      type: "checkpoints-replaced",
      sessionId: next.id,
      checkpoints: structuredClone(next.checkpoints),
    });
  return operations;
}

function appendedEventText(
  previous: AgentSessionSnapshot["events"][number],
  next: AgentSessionSnapshot["events"][number],
): string | null {
  const previousText = previous.text ?? "";
  const nextText = next.text ?? "";
  if (!nextText.startsWith(previousText)) return null;
  const { text: _previousText, createdAt: _previousCreatedAt, ...previousRest } = previous;
  const { text: _nextText, createdAt: _nextCreatedAt, ...nextRest } = next;
  return JSON.stringify(previousRest) === JSON.stringify(nextRest)
    ? nextText.slice(previousText.length)
    : null;
}

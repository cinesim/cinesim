import type { AgentEvent, AgentSessionSnapshot } from "../../shared/contracts";
import type { AgentRuntimeEvent } from "./runtimes/types";

const MAX_EVENTS_PER_SESSION = 600;
const MAX_EVENT_TEXT_BYTES = 1024 * 1024;
const MAX_EVENT_DETAIL_BYTES = 1024 * 1024;
const MAX_SESSION_EVENT_BYTES = 8 * 1024 * 1024;

type NewAgentEvent = Omit<AgentEvent, "id" | "sessionId" | "createdAt">;

function now(): string {
  return new Date().toISOString();
}

export function boundedAgentText(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value);
  return encoded.byteLength <= maximumBytes
    ? value
    : `${encoded.subarray(0, Math.max(0, maximumBytes - 3)).toString("utf8")}…`;
}

function normalizeEventStrings(event: AgentEvent): void {
  if (event.text) event.text = boundedAgentText(event.text, MAX_EVENT_TEXT_BYTES);
  if (event.detail) event.detail = boundedAgentText(event.detail, MAX_EVENT_DETAIL_BYTES);
  if (event.title) event.title = boundedAgentText(event.title, 4_096);
  if (event.toolName) event.toolName = boundedAgentText(event.toolName, 256);
}

function eventBytes(event: AgentEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}

export class AgentSessionEvents {
  readonly #sessionBytes = new Map<string, number>();

  prepareLoaded(session: AgentSessionSnapshot): void {
    for (const event of session.events) normalizeEventStrings(event);
    this.#enforceBudget(session, true);
  }

  remove(sessionId: string): void {
    this.#sessionBytes.delete(sessionId);
  }

  append(session: AgentSessionSnapshot, input: NewAgentEvent): AgentEvent {
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      createdAt: now(),
      ...input,
    };
    normalizeEventStrings(event);
    session.events.push(event);
    this.#sessionBytes.set(
      session.id,
      (this.#sessionBytes.get(session.id) ?? 0) + eventBytes(event),
    );
    this.#enforceBudget(session);
    return event;
  }

  completeTool(
    session: AgentSessionSnapshot,
    eventId: string,
    detail: string,
    failed: boolean,
  ): boolean {
    const event = session.events.find(({ id }) => id === eventId);
    if (!event) return false;
    event.kind = "tool-completed";
    event.status = failed ? "failed" : "completed";
    event.detail = detail;
    event.createdAt = now();
    normalizeEventStrings(event);
    this.#enforceBudget(session, true);
    return true;
  }

  appendRuntime(session: AgentSessionSnapshot, update: AgentRuntimeEvent): void {
    const target = this.#runtimeTextTarget(session, update);
    if (target && update.text) this.#appendText(session, target, update.text);
    else
      this.append(session, {
        ...update,
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      });
    this.#enforceBudget(session);
  }

  #runtimeTextTarget(session: AgentSessionSnapshot, update: AgentRuntimeEvent): AgentEvent | null {
    const last = session.events.at(-1);
    const appendable = Boolean(
      update.text &&
      (update.kind === "assistant-message" || update.kind === "reasoning") &&
      last?.kind === update.kind &&
      last.turnId === session.activeTurnId,
    );
    return appendable ? (last ?? null) : null;
  }

  #appendText(session: AgentSessionSnapshot, event: AgentEvent, text: string): void {
    const sessionBytes =
      this.#sessionBytes.get(session.id) ??
      session.events.reduce((total, candidate) => total + eventBytes(candidate), 0);
    const previousBytes = eventBytes(event);
    event.text = boundedAgentText(`${event.text ?? ""}${text}`, MAX_EVENT_TEXT_BYTES);
    event.createdAt = now();
    this.#sessionBytes.set(session.id, sessionBytes - previousBytes + eventBytes(event));
  }

  #enforceBudget(session: AgentSessionSnapshot, recalculate = false): void {
    let bytes =
      recalculate || !this.#sessionBytes.has(session.id)
        ? session.events.reduce((total, event) => total + eventBytes(event), 0)
        : this.#sessionBytes.get(session.id)!;
    while (
      session.events.length > 1 &&
      (session.events.length > MAX_EVENTS_PER_SESSION || bytes > MAX_SESSION_EVENT_BYTES)
    ) {
      bytes -= eventBytes(session.events.shift()!);
    }
    this.#sessionBytes.set(session.id, bytes);
  }
}

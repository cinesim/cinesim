import type { AgentSessionSnapshot } from "../../../shared/contracts";

export function turnStartedAt(session: AgentSessionSnapshot, turnId: string | undefined): number {
  if (!turnId) return Date.parse(session.updatedAt);
  const userMessage = session.events.find(
    (event) => event.turnId === turnId && event.kind === "user-message",
  );
  return Date.parse(userMessage?.createdAt ?? session.updatedAt);
}

export function formatRunningDuration(startedAt: number, now: number): string {
  return `${(Math.max(0, now - startedAt) / 1_000).toFixed(1)}s`;
}

export function formatTurnDuration(startedAt: number, completedAt: number): string {
  const seconds = Math.max(1, Math.ceil(Math.max(0, completedAt - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatTurnClock(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

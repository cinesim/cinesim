import type { AgentEffort, AgentEventKind, AgentTokenUsage } from "../../../shared/api";

export interface AgentRuntimeEvent {
  kind: AgentEventKind;
  text?: string;
  title?: string;
  detail?: string;
  toolName?: string;
  status?: "running" | "completed" | "failed" | "declined";
}

export interface AgentRuntimeCallbacks {
  onEvent(event: AgentRuntimeEvent): void;
  onProviderSessionId(providerSessionId: string): void;
  onTurnStarted(providerTurnId?: string): void;
  onTurnCompleted(status: "completed" | "failed" | "interrupted", detail?: string): void;
  onTokenUsage(usage: Omit<AgentTokenUsage, "updatedAt">): void;
  onApproval(title: string, detail: string): Promise<boolean>;
  onExit(detail?: string): void;
}

export interface AgentProviderRuntime {
  start(): Promise<void>;
  send(message: string): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentRuntimeLaunchOptions {
  executablePath: string;
  cwd: string;
  model: string;
  effort: AgentEffort;
  providerSessionId?: string;
  mcpUrl: string;
  mcpToken: string;
  instructions: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

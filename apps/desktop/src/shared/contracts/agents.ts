export type AgentProviderKind = "claude" | "codex";
export type AgentPermissionMode = "supervised" | "auto-edit";
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentProviderSettings {
  executablePath: string;
  model: string;
  effort: AgentEffort;
  permissionMode: AgentPermissionMode;
}

export interface AgentSettings {
  version: 1;
  defaultProvider: AgentProviderKind;
  projectInstructions: string;
  providers: Record<AgentProviderKind, AgentProviderSettings>;
}

export interface AgentProviderStatus {
  provider: AgentProviderKind;
  state: "connected" | "login-required" | "not-found" | "error";
  executablePath: string | null;
  version: string | null;
  accountLabel: string | null;
  detail: string | null;
}

export type AgentSessionStatus =
  | "idle"
  | "starting"
  | "working"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed";

export type AgentEventKind =
  | "user-message"
  | "assistant-message"
  | "reasoning"
  | "tool-started"
  | "tool-completed"
  | "approval-requested"
  | "approval-resolved"
  | "checkpoint"
  | "notice"
  | "error";

export interface AgentEvent {
  id: string;
  sessionId: string;
  turnId?: string;
  kind: AgentEventKind;
  createdAt: string;
  text?: string;
  title?: string;
  detail?: string;
  toolName?: string;
  requestId?: string;
  destructive?: boolean;
  status?: "running" | "completed" | "failed" | "declined";
}

export interface AgentCheckpoint {
  turnId: string;
  turnNumber: number;
  beforeRef: string;
  afterRef: string;
  summary: string;
  createdAt: string;
}

export interface AgentTokenUsage {
  usedTokens: number;
  maxTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalProcessedTokens?: number;
  updatedAt: string;
}

export interface AgentSessionSnapshot {
  id: string;
  projectDirectory: string;
  provider: AgentProviderKind;
  model: string;
  effort: AgentEffort;
  permissionMode: AgentPermissionMode;
  title: string;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  providerSessionId?: string | undefined;
  activeTurnId?: string | undefined;
  tokenUsage?: AgentTokenUsage | undefined;
  events: AgentEvent[];
  checkpoints: AgentCheckpoint[];
}

export interface AgentProjectSnapshot {
  projectDirectory: string;
  revision: number;
  activeSessionId: string | null;
  sessions: AgentSessionSnapshot[];
}

export type AgentSessionMetadataPatch = Partial<
  Omit<AgentSessionSnapshot, "id" | "projectDirectory" | "events" | "checkpoints" | "tokenUsage">
>;

export type AgentProjectDeltaOperation =
  | { type: "project-reset"; snapshot: AgentProjectSnapshot }
  | { type: "active-session-changed"; sessionId: string | null }
  | { type: "session-created"; session: AgentSessionSnapshot }
  | { type: "session-removed"; sessionId: string }
  | { type: "session-patched"; sessionId: string; patch: AgentSessionMetadataPatch }
  | { type: "event-appended"; sessionId: string; event: AgentEvent }
  | {
      type: "event-text-appended";
      sessionId: string;
      eventId: string;
      text: string;
      createdAt: string;
    }
  | { type: "event-patched"; sessionId: string; event: AgentEvent }
  | { type: "events-pruned"; sessionId: string; eventIds: string[] }
  | { type: "checkpoints-replaced"; sessionId: string; checkpoints: AgentCheckpoint[] }
  | { type: "token-usage-changed"; sessionId: string; usage: AgentTokenUsage | null };

export interface AgentProjectDelta {
  projectDirectory: string;
  baseRevision: number;
  revision: number;
  operations: AgentProjectDeltaOperation[];
}

export interface AgentTurnContext {
  workspace?: "media" | "cut" | "edit" | "effects";
  activeSequenceId?: string;
  playheadUs?: number;
  selectedIds?: string[];
  selectedAssetIds?: string[];
  selectedClipIds?: string[];
  compiler?: {
    diskValid: boolean;
    diagnosticCount: number;
    diagnostics: Array<{ code: string; message: string }>;
  };
}

export interface AgentCreateInput {
  projectDirectory: string;
  provider: AgentProviderKind;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: AgentPermissionMode;
}

export interface AgentSessionUpdate {
  model?: string;
  effort?: AgentEffort;
  permissionMode?: AgentPermissionMode;
}

export interface AgentSettingsUpdate {
  defaultProvider?: AgentProviderKind;
  projectInstructions?: string;
  provider?: AgentProviderKind;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: AgentPermissionMode;
}

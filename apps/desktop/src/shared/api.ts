import type { CommandResult, EditorCommand, Project, ProjectSettings } from "@cinesim/core";

export interface DesktopProjectSession {
  directory: string;
  project: Project;
  settings: ProjectSettings;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
}

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
  activeSessionId: string | null;
  sessions: AgentSessionSnapshot[];
}

export interface AgentTurnContext {
  activeSequenceId?: string;
  playheadUs?: number;
  selectedIds?: string[];
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
  provider?: AgentProviderKind;
  executablePath?: string;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: AgentPermissionMode;
}

export interface RecentProject {
  name: string;
  directory: string;
}

export interface ProjectViewState {
  openSequenceIds: string[];
  activeTab: string;
}

export interface DesktopAppState {
  version: 1;
  recentProjects: RecentProject[];
  projectViews: Record<string, ProjectViewState>;
}

export interface DesktopApi {
  createProject(name: string): Promise<DesktopProjectSession | null>;
  openProject(): Promise<DesktopProjectSession | null>;
  openRecentProject(directory: string): Promise<DesktopProjectSession>;
  importMedia(): Promise<DesktopProjectSession | null>;
  execute(
    command: EditorCommand,
  ): Promise<{ session: DesktopProjectSession; result: Omit<CommandResult, "project"> }>;
  undo(): Promise<DesktopProjectSession>;
  redo(): Promise<DesktopProjectSession>;
  save(): Promise<DesktopProjectSession>;
  revealProject(): Promise<void>;
  getSession(): Promise<DesktopProjectSession | null>;
  getAppState(): Promise<DesktopAppState>;
  setProjectView(view: ProjectViewState): Promise<DesktopAppState>;
  getAgentSettings(): Promise<AgentSettings>;
  updateAgentSettings(update: AgentSettingsUpdate): Promise<AgentSettings>;
  refreshAgentProviders(): Promise<AgentProviderStatus[]>;
  chooseAgentExecutable(provider: AgentProviderKind): Promise<AgentSettings | null>;
  openAgentLogin(provider: AgentProviderKind): Promise<string>;
  getAgents(projectDirectory: string): Promise<AgentProjectSnapshot>;
  ensureAgent(input: AgentCreateInput): Promise<AgentProjectSnapshot>;
  createAgent(input: AgentCreateInput): Promise<AgentProjectSnapshot>;
  updateAgent(sessionId: string, update: AgentSessionUpdate): Promise<AgentProjectSnapshot>;
  selectAgent(projectDirectory: string, sessionId: string): Promise<AgentProjectSnapshot>;
  deleteAgent(projectDirectory: string, sessionId: string): Promise<AgentProjectSnapshot>;
  sendAgentMessage(
    sessionId: string,
    message: string,
    context?: AgentTurnContext,
  ): Promise<AgentProjectSnapshot>;
  interruptAgent(sessionId: string): Promise<AgentProjectSnapshot>;
  respondAgentApproval(
    sessionId: string,
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<AgentProjectSnapshot>;
  revertAgentTurn(sessionId: string, turnId: string): Promise<AgentProjectSnapshot>;
  onAgentsChanged(callback: (snapshot: AgentProjectSnapshot) => void): () => void;
  onProjectChanged(callback: (session: DesktopProjectSession) => void): () => void;
  onCloseActiveTab(callback: () => void): () => void;
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    cinesim: DesktopApi;
  }
}

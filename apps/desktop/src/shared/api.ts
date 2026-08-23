import type { CommandResult, EditorCommand, Project, ProjectSettings } from "@cinesim/core";

export interface DesktopProjectSession {
  directory: string;
  project: Project;
  settings: ProjectSettings;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
}

export type DerivedArtifactKind = "thumbnail" | "filmstrip" | "proxy";
export type DerivedArtifactState = "missing" | "queued" | "running" | "ready" | "failed";

export interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  edgeHash: string;
}

export interface DerivedArtifactSnapshot {
  state: DerivedArtifactState;
  bytes?: number;
  progress?: number;
  failureCode?: string;
  updatedAt?: string;
  lastAccessAt?: string;
  sourceTimeUs?: number;
  tileTimesUs?: number[];
  columns?: number;
  rows?: number;
  tileWidth?: number;
  tileHeight?: number;
  profileId?: string;
}

export interface SourcePerformanceSnapshot {
  observations: number;
  warmSeekP50Ms?: number;
  warmSeekP95Ms?: number;
  deadlineMissRate?: number;
  requestsReceived: number;
  requestsCoalesced: number;
  framesPresented: number;
  framesObsolete: number;
}

export interface DerivedAssetSnapshot {
  assetId: string;
  fingerprintStatus: "current" | "stale" | "missing";
  thumbnail: DerivedArtifactSnapshot;
  filmstrip: DerivedArtifactSnapshot;
  proxy: DerivedArtifactSnapshot;
  performance: {
    original: SourcePerformanceSnapshot;
    proxy?: SourcePerformanceSnapshot;
    decision: "observing" | "original-sufficient" | "proxy-queued" | "proxy-ready" | "proxy-failed";
    reasons: string[];
  };
}

export interface DerivedMediaEvent {
  at: string;
  assetId?: string;
  kind: string;
  detail: string;
}

export interface DerivedMediaSnapshot {
  version: 1;
  generatorVersion: string;
  assets: Record<string, DerivedAssetSnapshot>;
  storage: {
    totalBytes: number;
    budgetBytes: number;
    safetyReserveBytes: number;
    thumbnailBytes: number;
    filmstripBytes: number;
    proxyBytes: number;
    evictionCount: number;
    lastEvictionReason?: string;
  };
  jobs: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
  };
  decisionLog: DerivedMediaEvent[];
}

export interface BeginDerivedWrite {
  assetId: string;
  kind: DerivedArtifactKind;
  expectedBytes?: number;
  profileId?: string;
}

export interface FinalizeDerivedWrite {
  bytes: number;
  sourceTimeUs?: number;
  tileTimesUs?: number[];
  columns?: number;
  rows?: number;
  tileWidth?: number;
  tileHeight?: number;
}

export interface DerivedPerformanceObservation {
  assetId: string;
  sourceKind: "original" | "proxy";
  operation: "sampling" | "hover-seek" | "playback";
  latencyMs?: number;
  deadlineMiss?: boolean;
  requestsReceived?: number;
  requestsCoalesced?: number;
  framesPresented?: number;
  framesObsolete?: number;
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

export interface EditorLayoutState {
  mediaPoolWidth: number;
  inspectorWidth: number;
  notesWidth: number;
  timelineHeight: number;
}

export const DEFAULT_EDITOR_LAYOUT: EditorLayoutState = {
  mediaPoolWidth: 248,
  inspectorWidth: 260,
  notesWidth: 300,
  timelineHeight: 288,
};

export const EDITOR_LAYOUT_LIMITS = {
  mediaPoolWidth: { min: 180, max: 480 },
  inspectorWidth: { min: 220, max: 480 },
  notesWidth: { min: 220, max: 480 },
  timelineHeight: { min: 160, max: 720 },
} as const;

export interface DesktopAppState {
  version: 1;
  recentProjects: RecentProject[];
  mediaPoolOpenByProject: Record<string, boolean>;
  inspectorOpenByProject: Record<string, boolean>;
  notesOpenByProject: Record<string, boolean>;
  editorLayoutsByProject: Record<string, EditorLayoutState>;
}

export interface DesktopApi {
  createProject(name: string): Promise<DesktopProjectSession | null>;
  openProject(): Promise<DesktopProjectSession | null>;
  openRecentProject(directory: string): Promise<DesktopProjectSession>;
  importMedia(): Promise<DesktopProjectSession | null>;
  getDerivedMediaSnapshot(): Promise<DerivedMediaSnapshot>;
  requestDerivedJobs(assetIds: string[]): Promise<DerivedMediaSnapshot>;
  beginDerivedWrite(input: BeginDerivedWrite): Promise<{ writerId: string }>;
  writeDerivedChunk(writerId: string, offset: number, data: Uint8Array): Promise<void>;
  finalizeDerivedWrite(writerId: string, result: FinalizeDerivedWrite): Promise<void>;
  cancelDerivedWrite(writerId: string): Promise<void>;
  reportDerivedPerformance(observation: DerivedPerformanceObservation): Promise<void>;
  execute(
    command: EditorCommand,
  ): Promise<{ session: DesktopProjectSession; result: Omit<CommandResult, "project"> }>;
  undo(): Promise<DesktopProjectSession>;
  redo(): Promise<DesktopProjectSession>;
  save(): Promise<DesktopProjectSession>;
  revealProject(): Promise<void>;
  getSession(): Promise<DesktopProjectSession | null>;
  getAppState(): Promise<DesktopAppState>;
  setProjectMediaPoolOpen(open: boolean): Promise<DesktopAppState>;
  setProjectInspectorOpen(open: boolean): Promise<DesktopAppState>;
  setProjectNotesOpen(open: boolean): Promise<DesktopAppState>;
  setProjectEditorLayout(layout: EditorLayoutState): Promise<DesktopAppState>;
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
  onDerivedMediaChanged(callback: (snapshot: DerivedMediaSnapshot) => void): () => void;
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    cinesim: DesktopApi;
  }
}

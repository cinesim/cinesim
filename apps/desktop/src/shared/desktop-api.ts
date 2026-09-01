import type { ProjectSettings, SemanticEditorCommand } from "@cinesim/core";
import type { VisualIndexAssetStatus, VisualIndexObservation } from "@cinesim/project-io";
import type { TranscriptAudioChunkInput, TranscriptSnapshot } from "./transcript";
import type { AccountSnapshot, SignInMethod } from "./contracts/account";
import type {
  AgentCreateInput,
  AgentProjectDelta,
  AgentProjectSnapshot,
  AgentProviderKind,
  AgentProviderStatus,
  AgentSessionUpdate,
  AgentSettings,
  AgentSettingsUpdate,
  AgentTurnContext,
} from "./contracts/agents";
import type {
  CutLayoutState,
  DesktopAppState,
  EditorLayoutState,
  TranscriptionSettings,
} from "./contracts/app-state";
import type { CloudStorageUsage, CloudTransferSnapshot } from "./contracts/cloud";
import type {
  BeginDerivedWrite,
  DerivedMediaSnapshot,
  DerivedPerformanceObservation,
  DerivedProjectScope,
  DerivedWorkerActivity,
  FinalizeDerivedWrite,
} from "./contracts/derived-media";
import type {
  FrameRenderCompletion,
  FrameRenderFailure,
  FrameRenderRequest,
} from "./contracts/frames";
import type {
  ExportCapabilitySnapshot,
  ExportJobSnapshot,
  ExportRenderCompletion,
  ExportRenderFailure,
  ExportRenderRequest,
  ExportStartRequest,
} from "./contracts/exports";
import type {
  VisualAnalysisCompletion,
  VisualAnalysisFailure,
  VisualAnalysisRequest,
} from "./contracts/visual-analysis";
import type { ElectronHealthSnapshot } from "./contracts/health";
import type {
  CreateProjectLocation,
  DesktopProjectSession,
  ProjectOpenTarget,
  ProjectOpenTargetId,
  DesktopCommandResult,
  DesktopProjectGuidance,
  RecentProjectDetails,
} from "./contracts/project";

export interface DesktopAccountApi {
  get(): Promise<AccountSnapshot>;
  beginSignIn(method: SignInMethod): Promise<void>;
  signOut(): Promise<AccountSnapshot>;
  onChanged(callback: (snapshot: AccountSnapshot) => void): () => void;
}

export interface DesktopCloudApi {
  getUsage(): Promise<CloudStorageUsage>;
  configureAddon(addonBytes: number): Promise<CloudStorageUsage>;
  getTransfers(): Promise<CloudTransferSnapshot[]>;
  retryTransfer(assetId: string): Promise<CloudTransferSnapshot[]>;
  cancelTransfer(assetId: string): Promise<CloudTransferSnapshot[]>;
  getDownloadedOriginals(): Promise<string[]>;
  keepOriginalDownloaded(assetId: string): Promise<string[]>;
  removeOriginalDownload(assetId: string): Promise<string[]>;
  trashAssets(cloudAssetIds: string[]): Promise<void>;
  restoreAsset(cloudAssetId: string): Promise<void>;
  deleteAsset(cloudAssetId: string): Promise<void>;
  onTransfersChanged(callback: (snapshot: CloudTransferSnapshot[]) => void): () => void;
}

export interface DesktopProjectApi {
  chooseCreateLocation(): Promise<CreateProjectLocation | null>;
  create(
    name: string,
    kind: "local" | "cloud",
    locationToken: string,
  ): Promise<DesktopProjectSession | null>;
  open(): Promise<DesktopProjectSession | null>;
  openRecent(directory: string): Promise<DesktopProjectSession>;
  getAgentGuidance(): Promise<DesktopProjectGuidance>;
  updateAgentGuidance(customInstructions: string): Promise<DesktopProjectGuidance>;
  revealAsset(assetId: string): Promise<void>;
  importMedia(): Promise<DesktopProjectSession | null>;
  execute(
    command: SemanticEditorCommand,
    expectedGeneration?: string,
  ): Promise<{ session: DesktopProjectSession; result: DesktopCommandResult }>;
  undo(): Promise<DesktopProjectSession>;
  redo(): Promise<DesktopProjectSession>;
  save(): Promise<DesktopProjectSession>;
  updateSettings(update: Partial<ProjectSettings>): Promise<DesktopProjectSession>;
  openTargets(): Promise<ProjectOpenTarget[]>;
  openWith(target: ProjectOpenTargetId): Promise<void>;
  forget(directory: string): Promise<DesktopAppState>;
  trash(directory: string): Promise<DesktopAppState>;
  getSession(): Promise<DesktopProjectSession | null>;
  getRecentDetails(): Promise<Record<string, RecentProjectDetails>>;
  onChanged(callback: (session: DesktopProjectSession) => void): () => void;
}

export interface DesktopDerivedApi {
  get(scope: DerivedProjectScope): Promise<DerivedMediaSnapshot>;
  requestJobs(scope: DerivedProjectScope, assetIds: string[]): Promise<DerivedMediaSnapshot>;
  requestProxies(scope: DerivedProjectScope, assetIds: string[]): Promise<DerivedMediaSnapshot>;
  beginWrite(scope: DerivedProjectScope, input: BeginDerivedWrite): Promise<{ writerId: string }>;
  writeChunk(writerId: string, offset: number, data: Uint8Array): Promise<void>;
  finalizeWrite(writerId: string, result: FinalizeDerivedWrite): Promise<void>;
  cancelWrite(writerId: string, failureCode?: string, detail?: string): Promise<void>;
  updateProgress(writerId: string, progress: number): Promise<void>;
  reportActivity(scope: DerivedProjectScope, activity: DerivedWorkerActivity): Promise<void>;
  reportPerformance(
    scope: DerivedProjectScope,
    observation: DerivedPerformanceObservation,
  ): Promise<void>;
  onChanged(callback: (snapshot: DerivedMediaSnapshot) => void): () => void;
}

export interface DesktopTranscriptApi {
  get(scope: DerivedProjectScope, assetIds?: string[]): Promise<TranscriptSnapshot>;
  requestJobs(scope: DerivedProjectScope, assetIds: string[]): Promise<TranscriptSnapshot>;
  regenerateJobs(scope: DerivedProjectScope, assetIds: string[]): Promise<TranscriptSnapshot>;
  cancelJobs(scope: DerivedProjectScope, assetIds: string[]): Promise<TranscriptSnapshot>;
  beginJob(scope: DerivedProjectScope, assetId: string): Promise<{ jobId: string }>;
  transcribeChunk(scope: DerivedProjectScope, input: TranscriptAudioChunkInput): Promise<void>;
  finalizeJob(scope: DerivedProjectScope, jobId: string): Promise<TranscriptSnapshot>;
  failJob(
    scope: DerivedProjectScope,
    jobId: string,
    failureCode: string,
    detail?: string,
  ): Promise<TranscriptSnapshot>;
  onChanged(callback: (snapshot: TranscriptSnapshot) => void): () => void;
}

export interface DesktopFrameApi {
  complete(scope: DerivedProjectScope, completion: FrameRenderCompletion): Promise<void>;
  fail(scope: DerivedProjectScope, failure: FrameRenderFailure): Promise<void>;
  onRequested(callback: (request: FrameRenderRequest) => void): () => void;
  onCanceled(callback: (request: { requestId: string }) => void): () => void;
}

export interface DesktopExportApi {
  capabilities(): Promise<ExportCapabilitySnapshot>;
  start(request: ExportStartRequest): Promise<ExportJobSnapshot>;
  status(jobId?: string): Promise<ExportJobSnapshot[]>;
  cancel(jobId: string): Promise<ExportJobSnapshot>;
  writeChunk(jobId: string, offset: number, data: Uint8Array): Promise<void>;
  updateProgress(jobId: string, progress: number): Promise<void>;
  complete(completion: ExportRenderCompletion): Promise<ExportJobSnapshot>;
  fail(failure: ExportRenderFailure): Promise<void>;
  onRequested(callback: (request: ExportRenderRequest) => void): () => void;
  onCanceled(callback: (request: { jobId: string }) => void): () => void;
  onChanged(callback: (jobs: ExportJobSnapshot[]) => void): () => void;
}

export interface DesktopVisualAnalysisApi {
  complete(scope: DerivedProjectScope, completion: VisualAnalysisCompletion): Promise<void>;
  fail(scope: DerivedProjectScope, failure: VisualAnalysisFailure): Promise<void>;
  onRequested(callback: (request: VisualAnalysisRequest) => void): () => void;
  onCanceled(callback: (request: { requestId: string }) => void): () => void;
}

export interface DesktopVisualIndexApi {
  status(scope: DerivedProjectScope, assetIds?: string[]): Promise<VisualIndexAssetStatus[]>;
  get(
    scope: DerivedProjectScope,
    assetId: string,
    range?: { fromUs?: number; toUs?: number; limit?: number },
  ): Promise<{
    status: VisualIndexAssetStatus;
    observations: VisualIndexObservation[];
    truncated: boolean;
  }>;
  generate(
    scope: DerivedProjectScope,
    assetIds: string[],
    force?: boolean,
  ): Promise<VisualIndexAssetStatus[]>;
  upsert(
    scope: DerivedProjectScope,
    assetId: string,
    observations: VisualIndexObservation[],
  ): Promise<VisualIndexAssetStatus>;
  delete(
    scope: DerivedProjectScope,
    assetId: string,
    selector: { observationIds?: string[]; fromUs?: number; toUs?: number },
  ): Promise<VisualIndexAssetStatus>;
  clear(scope: DerivedProjectScope, assetIds: string[]): Promise<VisualIndexAssetStatus[]>;
  onChanged(callback: () => void): () => void;
}

export interface DesktopAppStateApi {
  get(): Promise<DesktopAppState>;
  setMediaPoolOpen(open: boolean): Promise<DesktopAppState>;
  setInspectorOpen(open: boolean): Promise<DesktopAppState>;
  setNotesOpen(open: boolean): Promise<DesktopAppState>;
  setEditorLayout(layout: EditorLayoutState): Promise<DesktopAppState>;
  setCutLayout(layout: CutLayoutState): Promise<DesktopAppState>;
  setTranscriptionSettings(settings: TranscriptionSettings): Promise<DesktopAppState>;
  setNewProjectSettings(settings: ProjectSettings): Promise<DesktopAppState>;
}

export interface DesktopAgentApi {
  getSettings(): Promise<AgentSettings>;
  updateSettings(update: AgentSettingsUpdate): Promise<AgentSettings>;
  refreshProviders(): Promise<AgentProviderStatus[]>;
  chooseExecutable(provider: AgentProviderKind): Promise<AgentSettings | null>;
  openLogin(provider: AgentProviderKind): Promise<string>;
  get(projectDirectory: string): Promise<AgentProjectSnapshot>;
  ensure(input: AgentCreateInput): Promise<AgentProjectSnapshot>;
  create(input: AgentCreateInput): Promise<AgentProjectSnapshot>;
  update(sessionId: string, update: AgentSessionUpdate): Promise<AgentProjectSnapshot>;
  select(projectDirectory: string, sessionId: string): Promise<AgentProjectSnapshot>;
  delete(projectDirectory: string, sessionId: string): Promise<AgentProjectSnapshot>;
  send(
    sessionId: string,
    message: string,
    context?: AgentTurnContext,
  ): Promise<AgentProjectSnapshot>;
  interrupt(sessionId: string): Promise<AgentProjectSnapshot>;
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<AgentProjectSnapshot>;
  onDelta(callback: (delta: AgentProjectDelta) => void): () => void;
}

export interface DesktopApi {
  account: DesktopAccountApi;
  agents: DesktopAgentApi;
  appState: DesktopAppStateApi;
  cloud: DesktopCloudApi;
  derived: DesktopDerivedApi;
  exports: DesktopExportApi;
  frames: DesktopFrameApi;
  health: { get(): Promise<ElectronHealthSnapshot> };
  project: DesktopProjectApi;
  transcripts: DesktopTranscriptApi;
  visualIndex: DesktopVisualIndexApi;
  visualAnalysis: DesktopVisualAnalysisApi;
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    cinesim: DesktopApi;
  }
}

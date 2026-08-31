import type { AssetId, ClipId, SemanticEditorCommand, TimeUs } from "@cinesim/core";
import type { RuntimeSnapshot } from "@cinesim/engine";
import type {
  AccountSnapshot,
  CloudTransferSnapshot,
  CutLayoutState,
  DerivedMediaSnapshot,
  DesktopAppState,
  DesktopProjectSession,
  EditorLayoutState,
  ElectronHealthSnapshot,
  TranscriptionSettings,
} from "../../shared/contracts";
import type { TranscriptSnapshot } from "../../shared/transcript";

export type Destination = "home" | "project" | "settings";
export type ProjectSection = "media" | "cut" | "edit";
export type SettingsSection =
  | "general"
  | "media"
  | "transcription"
  | "storage"
  | "account"
  | "agents";
export type AuxiliarySidebarMode = "agents" | "metrics" | null;
export type EditTool = "select" | "trim" | "blade";
export type PanelKind = "mediaPool" | "inspector" | "notes";
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type ProjectLifecycle =
  | { status: "booting" }
  | { status: "idle" }
  | {
      status: "opening";
      operation: "create" | "open" | "open-recent";
      previousSession: DesktopProjectSession | null;
      requestId: number;
    }
  | { status: "ready"; session: DesktopProjectSession }
  | { status: "failed"; previousSession: DesktopProjectSession | null; error: string };

export interface PlaybackRuntimeState {
  projectDirectory: string;
  sequenceId: string;
  snapshot: RuntimeSnapshot;
}

export interface ProjectSlice {
  project: ProjectLifecycle;
  appState: DesktopAppState;
  destination: Destination;
  projectSection: ProjectSection;
  activeSequenceId: string | null;
  mediaPoolOpen: boolean;
  inspectorOpen: boolean;
  notesOpen: boolean;
  settingsSection: SettingsSection;
  auxiliaryMode: AuxiliarySidebarMode;
  operationError: string | null;
  initialize: () => Promise<void>;
  receiveExternalSession: (session: DesktopProjectSession) => Promise<void>;
  createProject: (
    name: string,
    kind: "local" | "cloud",
    locationToken: string,
  ) => Promise<ActionResult<DesktopProjectSession | null>>;
  openProject: () => Promise<ActionResult<DesktopProjectSession | null>>;
  openRecentProject: (directory: string) => Promise<ActionResult<DesktopProjectSession>>;
  importMedia: () => Promise<ActionResult<DesktopProjectSession | null>>;
  execute: (command: SemanticEditorCommand) => Promise<ActionResult<DesktopProjectSession>>;
  appendAsset: (
    assetId: string,
    sequenceId: string,
  ) => Promise<ActionResult<DesktopProjectSession>>;
  undo: () => Promise<ActionResult<DesktopProjectSession>>;
  redo: () => Promise<ActionResult<DesktopProjectSession>>;
  save: () => Promise<ActionResult<DesktopProjectSession>>;
  revealProject: () => Promise<ActionResult<void>>;
  forgetProject: (directory: string) => Promise<ActionResult<DesktopAppState>>;
  trashProject: (directory: string) => Promise<ActionResult<DesktopAppState>>;
  navigate: (destination: Destination) => void;
  showProjectSection: (section: ProjectSection) => void;
  showTimeline: (sequenceId: string) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setAuxiliaryMode: (mode: AuxiliarySidebarMode) => void;
  togglePanel: (panel: PanelKind) => Promise<ActionResult<DesktopAppState>>;
  saveEditorLayout: (layout: EditorLayoutState) => Promise<ActionResult<DesktopAppState>>;
  saveCutLayout: (layout: CutLayoutState) => Promise<ActionResult<DesktopAppState>>;
  saveTranscriptionSettings: (
    settings: TranscriptionSettings,
  ) => Promise<ActionResult<DesktopAppState>>;
  reportError: (message: string) => void;
  clearError: () => void;
  updateProjectSettings: (
    update: Partial<DesktopProjectSession["settings"]>,
  ) => Promise<ActionResult<DesktopProjectSession>>;
}

export interface EditorInteractionSlice {
  selectedClipId: ClipId | null;
  timelineZoom: number;
  timelineTrackHeight: number;
  timelineDragging: boolean;
  snappingEnabled: boolean;
  tool: EditTool;
  playheadUs: TimeUs;
  selectClip: (id: ClipId | null) => void;
  setTimelineZoom: (zoom: number) => void;
  setTimelineTrackHeight: (height: number) => void;
  setTimelineDragging: (dragging: boolean) => void;
  toggleSnapping: () => void;
  setTool: (tool: EditTool) => void;
  setPlayheadUs: (timeUs: TimeUs) => void;
}

export interface PlaybackMediaSlice {
  playbackRuntime: PlaybackRuntimeState | null;
  derivedMedia: DerivedMediaSnapshot | null;
  transcripts: TranscriptSnapshot | null;
  electronHealth: ElectronHealthSnapshot | null;
  setPlaybackRuntime: (
    projectDirectory: string,
    sequenceId: string,
    snapshot: RuntimeSnapshot | null,
  ) => void;
  setDerivedMedia: (projectDirectory: string, snapshot: DerivedMediaSnapshot | null) => void;
  setTranscripts: (projectDirectory: string, snapshot: TranscriptSnapshot | null) => void;
  loadTranscripts: (assetIds: AssetId[]) => Promise<ActionResult<TranscriptSnapshot>>;
  requestTranscripts: (assetIds: AssetId[]) => Promise<ActionResult<TranscriptSnapshot>>;
  cancelTranscripts: (assetIds: AssetId[]) => Promise<ActionResult<TranscriptSnapshot>>;
  setElectronHealth: (snapshot: ElectronHealthSnapshot | null) => void;
}

export interface AccountCloudSlice {
  account: AccountSnapshot;
  accountHydrated: boolean;
  cloudTransfers: CloudTransferSnapshot[];
  downloadedCloudOriginals: string[];
  setAccount: (snapshot: AccountSnapshot) => void;
  refreshAccount: () => Promise<void>;
  beginAccountSignIn: (method: "email" | "google") => Promise<ActionResult<void>>;
  signOutAccount: () => Promise<ActionResult<AccountSnapshot>>;
  setCloudTransfers: (snapshot: CloudTransferSnapshot[]) => void;
  retryCloudTransfer: (assetId: string) => Promise<ActionResult<CloudTransferSnapshot[]>>;
  cancelCloudTransfer: (assetId: string) => Promise<ActionResult<CloudTransferSnapshot[]>>;
  keepCloudOriginalDownloaded: (assetId: string) => Promise<ActionResult<string[]>>;
  removeCloudOriginalDownload: (assetId: string) => Promise<ActionResult<string[]>>;
}

export interface RendererState
  extends ProjectSlice, EditorInteractionSlice, PlaybackMediaSlice, AccountCloudSlice {}

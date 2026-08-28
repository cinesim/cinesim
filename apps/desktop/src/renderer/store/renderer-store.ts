import { createStore } from "zustand/vanilla";
import { isAssetCompatibleWithTrack, sequenceDurationUs } from "@cinesim/core";
import type { ClipId, EditorCommand, Sequence, TimeUs } from "@cinesim/core";
import type { RuntimeSnapshot } from "@cinesim/engine";
import { DEFAULT_EDITOR_LAYOUT } from "../../shared/api";
import type {
  AccountSnapshot,
  CloudTransferSnapshot,
  DerivedMediaSnapshot,
  DesktopApi,
  DesktopAppState,
  DesktopProjectSession,
  EditorLayoutState,
  ElectronHealthSnapshot,
} from "../../shared/api";
import { clampTimelineZoom } from "../lib/timeline-scale";

export type Destination = "home" | "project" | "settings";
export type ProjectSection = "media" | "edit";
export type SettingsSection = "general" | "media" | "storage" | "account" | "agents";
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

interface RendererStoreDependencies {
  api: DesktopApi;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export interface RendererState {
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
  selectedClipId: ClipId | null;
  timelineZoom: number;
  timelineTrackHeight: number;
  timelineDragging: boolean;
  snappingEnabled: boolean;
  tool: EditTool;
  playheadUs: TimeUs;
  playbackRuntime: PlaybackRuntimeState | null;
  derivedMedia: DerivedMediaSnapshot | null;
  electronHealth: ElectronHealthSnapshot | null;
  account: AccountSnapshot;
  accountHydrated: boolean;
  cloudTransfers: CloudTransferSnapshot[];
  downloadedCloudOriginals: string[];
  initialize: () => Promise<void>;
  receiveExternalSession: (session: DesktopProjectSession) => Promise<void>;
  createProject: (
    name: string,
    kind: "local" | "cloud",
  ) => Promise<ActionResult<DesktopProjectSession | null>>;
  openProject: () => Promise<ActionResult<DesktopProjectSession | null>>;
  openRecentProject: (directory: string) => Promise<ActionResult<DesktopProjectSession>>;
  importMedia: () => Promise<ActionResult<DesktopProjectSession | null>>;
  execute: (command: EditorCommand) => Promise<ActionResult<DesktopProjectSession>>;
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
  clearError: () => void;
  selectClip: (id: ClipId | null) => void;
  setTimelineZoom: (zoom: number) => void;
  setTimelineTrackHeight: (height: number) => void;
  setTimelineDragging: (dragging: boolean) => void;
  toggleSnapping: () => void;
  setTool: (tool: EditTool) => void;
  setPlayheadUs: (timeUs: TimeUs) => void;
  setPlaybackRuntime: (
    projectDirectory: string,
    sequenceId: string,
    snapshot: RuntimeSnapshot | null,
  ) => void;
  setDerivedMedia: (projectDirectory: string, snapshot: DerivedMediaSnapshot | null) => void;
  setElectronHealth: (snapshot: ElectronHealthSnapshot | null) => void;
  setAccount: (snapshot: AccountSnapshot) => void;
  refreshAccount: () => Promise<void>;
  beginAccountSignIn: (method: "email" | "google") => Promise<ActionResult<void>>;
  signOutAccount: () => Promise<ActionResult<AccountSnapshot>>;
  setCloudTransfers: (snapshot: CloudTransferSnapshot[]) => void;
  retryCloudTransfer: (assetId: string) => Promise<ActionResult<CloudTransferSnapshot[]>>;
  cancelCloudTransfer: (assetId: string) => Promise<ActionResult<CloudTransferSnapshot[]>>;
  keepCloudOriginalDownloaded: (assetId: string) => Promise<ActionResult<string[]>>;
  removeCloudOriginalDownload: (assetId: string) => Promise<ActionResult<string[]>>;
  updateProjectSettings: (
    update: Partial<DesktopProjectSession["settings"]>,
  ) => Promise<ActionResult<DesktopProjectSession>>;
}

export const EMPTY_APP_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  mediaPoolOpenByProject: {},
  inspectorOpenByProject: {},
  notesOpenByProject: {},
  editorLayoutsByProject: {},
};

export const INITIAL_ACCOUNT_STATE: AccountSnapshot = {
  status: "signed-out",
  cloudOrigin: null,
  serviceAvailable: false,
  googleSignIn: false,
  cloudStorage: false,
  user: null,
  detail: null,
};

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function sessionFromLifecycle(project: ProjectLifecycle): DesktopProjectSession | null {
  if (project.status === "ready") return project.session;
  if (project.status === "opening" || project.status === "failed") return project.previousSession;
  return null;
}

export function activeSequenceFromState(state: RendererState): Sequence | null {
  const session = sessionFromLifecycle(state.project);
  if (!session) return null;
  return (
    session.project.sequences.find((sequence) => sequence.id === state.activeSequenceId) ??
    session.project.sequences.find(
      (sequence) => sequence.id === session.project.activeSequenceId,
    ) ??
    null
  );
}

export function editorLayoutFromState(state: RendererState): EditorLayoutState {
  const session = sessionFromLifecycle(state.project);
  return session
    ? (state.appState.editorLayoutsByProject[session.directory] ?? DEFAULT_EDITOR_LAYOUT)
    : DEFAULT_EDITOR_LAYOUT;
}

function clipExists(sequence: Sequence | null, clipId: ClipId | null): boolean {
  return Boolean(
    sequence &&
    clipId &&
    sequence.tracks.some((track) => track.clips.some((clip) => clip.id === clipId)),
  );
}

function hydratedProjectState(
  session: DesktopProjectSession,
  appState: DesktopAppState,
): Partial<RendererState> {
  return {
    project: { status: "ready", session },
    appState,
    destination: "project",
    projectSection: "media",
    activeSequenceId: session.project.activeSequenceId,
    mediaPoolOpen: appState.mediaPoolOpenByProject[session.directory] ?? true,
    inspectorOpen: appState.inspectorOpenByProject[session.directory] ?? true,
    notesOpen: appState.notesOpenByProject[session.directory] ?? true,
    operationError: null,
    selectedClipId: null,
    timelineDragging: false,
    playheadUs: 0,
    playbackRuntime: null,
    derivedMedia: null,
  };
}

function appStateWithRememberedProject(
  appState: DesktopAppState,
  session: DesktopProjectSession,
): DesktopAppState {
  return {
    ...appState,
    recentProjects: [
      {
        name: session.project.name,
        directory: session.directory,
        kind: session.project.cloudProjectId ? ("cloud" as const) : ("local" as const),
      },
      ...appState.recentProjects.filter((project) => project.directory !== session.directory),
    ].slice(0, 12),
  };
}

export type RendererStoreApi = ReturnType<typeof createRendererStore>;

export function createRendererStore({ api, storage }: RendererStoreDependencies) {
  let nextRequestId = 0;
  let initialization: Promise<void> | null = null;

  return createStore<RendererState>()((set, get) => {
    function blockedByProjectOpening<T>(): ActionResult<T> | null {
      return get().project.status === "opening"
        ? { ok: false, error: "Wait for the project to finish opening" }
        : null;
    }

    function acceptMutationSession(session: DesktopProjectSession): void {
      const current = get();
      const previous = sessionFromLifecycle(current.project);
      if (previous && previous.directory !== session.directory) return;
      const requestedSequenceId = current.activeSequenceId ?? session.project.activeSequenceId;
      const activeSequence =
        session.project.sequences.find((sequence) => sequence.id === requestedSequenceId) ??
        session.project.sequences.find(
          (sequence) => sequence.id === session.project.activeSequenceId,
        ) ??
        null;
      const activeSequenceId = activeSequence?.id ?? null;
      const sequenceChanged = activeSequenceId !== current.activeSequenceId;
      set({
        project: { status: "ready", session },
        operationError: null,
        activeSequenceId,
        selectedClipId: clipExists(activeSequence, current.selectedClipId)
          ? current.selectedClipId
          : null,
        playheadUs: activeSequence
          ? Math.min(current.playheadUs, sequenceDurationUs(activeSequence))
          : 0,
        playbackRuntime: sequenceChanged ? null : current.playbackRuntime,
      });
    }

    async function runProjectOperation<T extends DesktopProjectSession | null>(
      operation: "create" | "open" | "open-recent",
      invoke: () => Promise<T>,
    ): Promise<ActionResult<T>> {
      if (get().project.status === "opening")
        return { ok: false, error: "Another project operation is already in progress" };
      const requestId = ++nextRequestId;
      const previousSession = sessionFromLifecycle(get().project);
      set({
        project: { status: "opening", operation, previousSession, requestId },
        operationError: null,
      });
      try {
        const session = await invoke();
        const currentProject = get().project;
        if (currentProject.status !== "opening" || currentProject.requestId !== requestId)
          return { ok: false, error: "A newer project operation replaced this request" };
        if (!session) {
          set({
            project: previousSession
              ? { status: "ready", session: previousSession }
              : { status: "idle" },
          });
          return { ok: true, value: session };
        }
        const appState = appStateWithRememberedProject(get().appState, session);
        const [transfersResult, downloadsResult] = await Promise.allSettled([
          api.getCloudTransfers?.() ?? Promise.resolve([]),
          api.getDownloadedCloudOriginals?.() ?? Promise.resolve([]),
        ]);
        set({
          ...hydratedProjectState(session, appState),
          cloudTransfers: transfersResult.status === "fulfilled" ? transfersResult.value : [],
          downloadedCloudOriginals:
            downloadsResult.status === "fulfilled" ? downloadsResult.value : [],
        });
        return { ok: true, value: session };
      } catch (error) {
        const message = messageFrom(error, "The project could not be opened");
        set({
          project: { status: "failed", previousSession, error: message },
          destination: previousSession ? get().destination : "home",
          operationError: message,
        });
        return { ok: false, error: message };
      }
    }

    async function runSessionAction(
      invoke: () => Promise<DesktopProjectSession>,
      fallback: string,
    ): Promise<ActionResult<DesktopProjectSession>> {
      const blocked = blockedByProjectOpening<DesktopProjectSession>();
      if (blocked) return blocked;
      set({ operationError: null });
      try {
        const session = await invoke();
        acceptMutationSession(session);
        return { ok: true, value: session };
      } catch (error) {
        const message = messageFrom(error, fallback);
        set({ operationError: message });
        return { ok: false, error: message };
      }
    }

    async function hydrateAccountWorkspace(): Promise<void> {
      const [sessionResult, appStateResult, transfersResult, downloadsResult] =
        await Promise.allSettled([
          api.getSession(),
          api.getAppState(),
          api.getCloudTransfers?.() ?? Promise.resolve([]),
          api.getDownloadedCloudOriginals?.() ?? Promise.resolve([]),
        ]);
      if (sessionResult.status === "rejected") {
        const message = messageFrom(sessionResult.reason, "Cinesim could not load your projects");
        set({
          project: { status: "failed", previousSession: null, error: message },
          appState: EMPTY_APP_STATE,
          cloudTransfers: [],
          downloadedCloudOriginals: [],
          operationError: message,
        });
        return;
      }
      const appState =
        appStateResult.status === "fulfilled" ? appStateResult.value : EMPTY_APP_STATE;
      const cloudTransfers = transfersResult.status === "fulfilled" ? transfersResult.value : [];
      const downloadedCloudOriginals =
        downloadsResult.status === "fulfilled" ? downloadsResult.value : [];
      if (sessionResult.value)
        set({
          ...hydratedProjectState(sessionResult.value, appState),
          cloudTransfers,
          downloadedCloudOriginals,
        });
      else set({ project: { status: "idle" }, appState, cloudTransfers, downloadedCloudOriginals });
    }

    const initialAuxiliaryMode =
      storage?.getItem("cinesim.agentsSidebarOpen") === "true" ? "agents" : null;

    return {
      project: { status: "booting" },
      appState: EMPTY_APP_STATE,
      destination: "home",
      projectSection: "media",
      activeSequenceId: null,
      mediaPoolOpen: true,
      inspectorOpen: true,
      notesOpen: true,
      settingsSection: "general",
      auxiliaryMode: initialAuxiliaryMode,
      operationError: null,
      selectedClipId: null,
      timelineZoom: 1,
      timelineTrackHeight: 56,
      timelineDragging: false,
      snappingEnabled: true,
      tool: "select",
      playheadUs: 0,
      playbackRuntime: null,
      derivedMedia: null,
      electronHealth: null,
      account: INITIAL_ACCOUNT_STATE,
      accountHydrated: false,
      cloudTransfers: [],
      downloadedCloudOriginals: [],

      initialize: () => {
        if (initialization) return initialization;
        if (get().project.status !== "booting") return Promise.resolve();

        initialization = (async () => {
          const workspace = hydrateAccountWorkspace();
          const account = await api.getAccountSnapshot().catch(() => INITIAL_ACCOUNT_STATE);
          set({ account, accountHydrated: true });
          await workspace;
          const accountAppState = await api.getAppState().catch(() => null);
          if (accountAppState) set({ appState: accountAppState });
        })();
        return initialization;
      },

      receiveExternalSession: async (session) => {
        const current = get();
        const previous = sessionFromLifecycle(current.project);
        if (current.project.status === "opening" && session.directory === previous?.directory)
          return;
        if (previous?.directory === session.directory) {
          acceptMutationSession(session);
          return;
        }
        let appState = current.appState;
        try {
          appState = await api.getAppState();
        } catch {
          // Project state is authoritative; UI preferences can use their current defaults.
        }
        set(hydratedProjectState(session, appState));
      },

      createProject: (name, kind) =>
        runProjectOperation("create", () => api.createProject(name.trim(), kind)),
      openProject: () => runProjectOperation("open", () => api.openProject()),
      openRecentProject: (directory) =>
        runProjectOperation("open-recent", () => api.openRecentProject(directory)),

      importMedia: async () => {
        const blocked = blockedByProjectOpening<DesktopProjectSession | null>();
        if (blocked) return blocked;
        set({ operationError: null });
        try {
          const session = await api.importMedia();
          if (session) acceptMutationSession(session);
          return { ok: true, value: session };
        } catch (error) {
          const message = messageFrom(error, "The media could not be imported");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },

      execute: async (command) => {
        const blocked = blockedByProjectOpening<DesktopProjectSession>();
        if (blocked) return blocked;
        set({ operationError: null });
        try {
          const response = await api.execute(command);
          acceptMutationSession(response.session);
          return { ok: true, value: response.session };
        } catch (error) {
          const message = messageFrom(error, "The edit could not be applied");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },

      appendAsset: async (assetId, sequenceId) => {
        const session = sessionFromLifecycle(get().project);
        const sequence = session?.project.sequences.find(
          (candidate) => candidate.id === sequenceId,
        );
        const asset = session?.project.assets.find((candidate) => candidate.id === assetId);
        if (!session || !sequence || !asset) {
          const error = "The selected asset or timeline is no longer available";
          set({ operationError: error });
          return { ok: false, error };
        }
        const track = sequence.tracks.find(
          (candidate) =>
            !candidate.locked && isAssetCompatibleWithTrack(asset.kind, candidate.kind),
        );
        if (!track) {
          const error = `The timeline has no unlocked track compatible with ${asset.kind} media`;
          set({ operationError: error });
          return { ok: false, error };
        }
        const audioTrack =
          asset.kind === "video" && asset.hasAudio === true
            ? sequence.tracks.find((candidate) => candidate.kind === "audio" && !candidate.locked)
            : null;
        return get().execute({
          type: "clip.add",
          trackId: track.id,
          assetId: asset.id,
          timelineStartUs: sequenceDurationUs(sequence),
          ...(audioTrack ? { audioTrackId: audioTrack.id } : {}),
        });
      },

      undo: () => runSessionAction(() => api.undo(), "The edit could not be undone"),
      redo: () => runSessionAction(() => api.redo(), "The edit could not be redone"),
      save: () => runSessionAction(() => api.save(), "The project could not be saved"),
      revealProject: async () => {
        const blocked = blockedByProjectOpening<void>();
        if (blocked) return blocked;
        try {
          await api.revealProject();
          return { ok: true, value: undefined };
        } catch (error) {
          const message = messageFrom(error, "The project could not be revealed");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },
      forgetProject: async (directory) => {
        try {
          const appState = await api.forgetProject(directory);
          set({ appState, operationError: null });
          return { ok: true, value: appState };
        } catch (error) {
          const message = messageFrom(error, "The project could not be forgotten");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },
      trashProject: async (directory) => {
        const current = get();
        const session = sessionFromLifecycle(current.project);
        const deletingCurrent = session?.directory === directory;
        if (deletingCurrent) {
          set({
            project: { status: "idle" },
            destination: "home",
            activeSequenceId: null,
            selectedClipId: null,
            playbackRuntime: null,
            derivedMedia: null,
            operationError: null,
          });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        try {
          const appState = await api.trashProject(directory);
          set({ appState, operationError: null });
          return { ok: true, value: appState };
        } catch (error) {
          const message = messageFrom(error, "The project could not be moved to Trash");
          if (deletingCurrent) {
            try {
              const reopened = await api.openRecentProject(directory);
              set(hydratedProjectState(reopened, get().appState));
            } catch {
              // The project remains closed if recovery also fails.
            }
          }
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },

      navigate: (destination) => set({ destination }),
      showProjectSection: (projectSection) => {
        if (!sessionFromLifecycle(get().project)) return;
        set({ projectSection, destination: "project" });
      },
      showTimeline: (sequenceId) => {
        const session = sessionFromLifecycle(get().project);
        if (!session?.project.sequences.some((sequence) => sequence.id === sequenceId)) return;
        set({
          activeSequenceId: sequenceId,
          projectSection: "edit",
          destination: "project",
          selectedClipId: null,
          playheadUs: 0,
          playbackRuntime: null,
        });
      },
      setSettingsSection: (settingsSection) => set({ settingsSection }),
      setAuxiliaryMode: (auxiliaryMode) => {
        storage?.setItem("cinesim.agentsSidebarOpen", String(auxiliaryMode === "agents"));
        set({ auxiliaryMode });
      },

      togglePanel: async (panel) => {
        const blocked = blockedByProjectOpening<DesktopAppState>();
        if (blocked) return blocked;
        const key = `${panel}Open` as "mediaPoolOpen" | "inspectorOpen" | "notesOpen";
        const previous = get()[key];
        const next = !previous;
        set({ [key]: next } as Pick<RendererState, typeof key>);
        try {
          const appState = await (panel === "mediaPool"
            ? api.setProjectMediaPoolOpen(next)
            : panel === "inspector"
              ? api.setProjectInspectorOpen(next)
              : api.setProjectNotesOpen(next));
          set({ appState });
          return { ok: true, value: appState };
        } catch (error) {
          const message = messageFrom(error, "The panel preference could not be saved");
          if (get()[key] === next) set({ [key]: previous } as Pick<RendererState, typeof key>);
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },

      saveEditorLayout: async (layout) => {
        const blocked = blockedByProjectOpening<DesktopAppState>();
        if (blocked) return blocked;
        try {
          const appState = await api.setProjectEditorLayout(layout);
          set({ appState });
          return { ok: true, value: appState };
        } catch (error) {
          const message = messageFrom(error, "The editor layout could not be saved");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },

      clearError: () => {
        const project = get().project;
        set({
          project:
            project.status === "failed"
              ? project.previousSession
                ? { status: "ready", session: project.previousSession }
                : { status: "idle" }
              : project,
          operationError: null,
        });
      },
      selectClip: (selectedClipId) => set({ selectedClipId }),
      setTimelineZoom: (timelineZoom) => set({ timelineZoom: clampTimelineZoom(timelineZoom) }),
      setTimelineTrackHeight: (timelineTrackHeight) =>
        set({ timelineTrackHeight: Math.min(112, Math.max(40, Math.round(timelineTrackHeight))) }),
      setTimelineDragging: (timelineDragging) => set({ timelineDragging }),
      toggleSnapping: () => set((state) => ({ snappingEnabled: !state.snappingEnabled })),
      setTool: (tool) => set({ tool }),
      setPlayheadUs: (playheadUs) => set({ playheadUs }),
      setPlaybackRuntime: (projectDirectory, sequenceId, snapshot) => {
        const current = get();
        const session = sessionFromLifecycle(current.project);
        if (session?.directory !== projectDirectory || current.activeSequenceId !== sequenceId)
          return;
        set({
          playbackRuntime: snapshot ? { projectDirectory, sequenceId, snapshot } : null,
          ...(snapshot ? { playheadUs: snapshot.timeUs } : {}),
        });
      },
      setDerivedMedia: (projectDirectory, derivedMedia) => {
        const session = sessionFromLifecycle(get().project);
        if (
          session?.directory !== projectDirectory ||
          (derivedMedia &&
            (derivedMedia.projectScope.cacheKey !== session.derivedScope.cacheKey ||
              derivedMedia.projectScope.epoch !== session.derivedScope.epoch))
        )
          return;
        set({ derivedMedia });
      },
      setElectronHealth: (electronHealth) => set({ electronHealth }),
      setAccount: (account) => {
        const previousUserId = get().account.user?.id ?? null;
        set({ account, accountHydrated: true });
        const session = sessionFromLifecycle(get().project);
        if (!account.user) {
          set(
            session?.project.cloudProjectId
              ? {
                  project: { status: "idle" },
                  destination: "home",
                  cloudTransfers: [],
                  downloadedCloudOriginals: [],
                }
              : { cloudTransfers: [], downloadedCloudOriginals: [] },
          );
          void api
            .getAppState()
            .then((appState) => set({ appState }))
            .catch(() => undefined);
        } else if (account.user.id !== previousUserId) {
          if (session?.project.cloudProjectId) {
            set({
              project: { status: "booting" },
              appState: EMPTY_APP_STATE,
              cloudTransfers: [],
              downloadedCloudOriginals: [],
            });
            void hydrateAccountWorkspace();
          } else {
            void api
              .getAppState()
              .then((appState) => set({ appState }))
              .catch(() => undefined);
          }
        }
      },
      refreshAccount: async () => {
        try {
          get().setAccount(await api.getAccountSnapshot());
        } catch {
          set({
            account: {
              ...get().account,
              status: get().account.user ? "offline" : "signed-out",
              serviceAvailable: false,
              detail: "The authentication service is unavailable. Local editing still works.",
            },
            accountHydrated: true,
          });
        }
      },
      beginAccountSignIn: async (method) => {
        try {
          await api.beginAccountSignIn(method);
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, error: messageFrom(error, "Sign-in could not be started") };
        }
      },
      signOutAccount: async () => {
        try {
          const account = await api.signOutAccount();
          get().setAccount(account);
          return { ok: true, value: account };
        } catch (error) {
          return { ok: false, error: messageFrom(error, "Could not sign out") };
        }
      },
      setCloudTransfers: (cloudTransfers) => set({ cloudTransfers }),
      retryCloudTransfer: async (assetId) => {
        try {
          const cloudTransfers = await api.retryCloudTransfer(assetId);
          set({ cloudTransfers, operationError: null });
          return { ok: true, value: cloudTransfers };
        } catch (error) {
          const message = messageFrom(error, "The cloud transfer could not be retried");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },
      cancelCloudTransfer: async (assetId) => {
        try {
          const cloudTransfers = await api.cancelCloudTransfer(assetId);
          set({ cloudTransfers, operationError: null });
          return { ok: true, value: cloudTransfers };
        } catch (error) {
          const message = messageFrom(error, "The cloud transfer could not be canceled");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },
      keepCloudOriginalDownloaded: async (assetId) => {
        try {
          const downloadedCloudOriginals = await api.keepCloudOriginalDownloaded(assetId);
          set({ downloadedCloudOriginals, operationError: null });
          return { ok: true, value: downloadedCloudOriginals };
        } catch (error) {
          const message = messageFrom(error, "The cloud original could not be downloaded");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },
      removeCloudOriginalDownload: async (assetId) => {
        try {
          const downloadedCloudOriginals = await api.removeCloudOriginalDownload(assetId);
          set({ downloadedCloudOriginals, operationError: null });
          return { ok: true, value: downloadedCloudOriginals };
        } catch (error) {
          const message = messageFrom(error, "The downloaded original could not be removed");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },
      updateProjectSettings: async (update) => {
        try {
          const session = await api.updateProjectSettings(update);
          acceptMutationSession(session);
          return { ok: true, value: session };
        } catch (error) {
          const message = messageFrom(error, "The project settings could not be updated");
          set({ operationError: message });
          return { ok: false, error: message };
        }
      },
    };
  });
}

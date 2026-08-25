import { createStore } from "zustand/vanilla";
import { isAssetCompatibleWithTrack, sequenceDurationUs } from "@cinesim/core";
import type { ClipId, EditorCommand, Sequence, TimeUs } from "@cinesim/core";
import type { RuntimeSnapshot } from "@cinesim/engine";
import { DEFAULT_EDITOR_LAYOUT } from "../../shared/api";
import type {
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
export type SettingsSection = "general" | "agents";
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
  initialize: () => Promise<void>;
  receiveExternalSession: (session: DesktopProjectSession) => Promise<void>;
  createProject: (name: string) => Promise<ActionResult<DesktopProjectSession | null>>;
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
}

export const EMPTY_APP_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  mediaPoolOpenByProject: {},
  inspectorOpenByProject: {},
  notesOpenByProject: {},
  editorLayoutsByProject: {},
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

export type RendererStoreApi = ReturnType<typeof createRendererStore>;

export function createRendererStore({ api, storage }: RendererStoreDependencies) {
  let nextRequestId = 0;

  return createStore<RendererState>()((set, get) => {
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
        let appState = get().appState;
        try {
          appState = await api.getAppState();
        } catch {
          // Opening the canonical project succeeded; stale UI preferences are safe defaults.
        }
        set(hydratedProjectState(session, appState));
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

      initialize: async () => {
        const [sessionResult, appStateResult] = await Promise.allSettled([
          api.getSession(),
          api.getAppState(),
        ]);
        if (get().project.status !== "booting") return;
        if (sessionResult.status === "rejected") {
          const message = messageFrom(sessionResult.reason, "Cinesim could not start");
          set({
            project: { status: "failed", previousSession: null, error: message },
            operationError: message,
          });
          return;
        }
        const appState =
          appStateResult.status === "fulfilled" ? appStateResult.value : EMPTY_APP_STATE;
        if (sessionResult.value) set(hydratedProjectState(sessionResult.value, appState));
        else set({ project: { status: "idle" }, appState });
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

      createProject: (name) => runProjectOperation("create", () => api.createProject(name.trim())),
      openProject: () => runProjectOperation("open", () => api.openProject()),
      openRecentProject: (directory) =>
        runProjectOperation("open-recent", () => api.openRecentProject(directory)),

      importMedia: async () => {
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
        try {
          await api.revealProject();
          return { ok: true, value: undefined };
        } catch (error) {
          const message = messageFrom(error, "The project could not be revealed");
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
    };
  });
}

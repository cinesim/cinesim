import { isAssetCompatibleWithTrack, sequenceDurationUs, timeUs } from "@cinesim/core";
import type { DesktopAppState, DesktopProjectSession } from "../../shared/contracts";
import {
  EMPTY_APP_STATE,
  hydratedProjectState,
  messageFrom,
  sessionFromLifecycle,
} from "./renderer-project-state";
import type { ProjectSlice, RendererState } from "./renderer-state";
import type { RendererStoreContext } from "./renderer-store-coordinator";

export function createProjectSlice(context: RendererStoreContext): ProjectSlice {
  const { api, get, set, storage } = context;
  const initialAuxiliaryMode =
    storage?.getItem("cinesim.agentsSidebarOpen") === "true" ? "agents" : null;

  return {
    project: { status: "booting" },
    appState: EMPTY_APP_STATE,
    destination: "home",
    projectSection: "media",
    activeSequenceId: null,
    selectedAssetIds: [],
    mediaPoolOpen: true,
    inspectorOpen: true,
    notesOpen: true,
    settingsSection: "general",
    auxiliaryMode: initialAuxiliaryMode,
    operationError: null,
    initialize: () => context.initialize(),
    receiveExternalSession: async (session) => {
      const current = get();
      const previous = sessionFromLifecycle(current.project);
      if (current.project.status === "opening" && session.directory === previous?.directory) return;
      if (previous?.directory === session.directory) {
        context.acceptMutationSession(session);
        return;
      }
      let appState = current.appState;
      try {
        appState = await api.appState.get();
      } catch {
        // Project state is authoritative; UI preferences can use their current defaults.
      }
      set(hydratedProjectState(session, appState));
    },
    createProject: (name, kind, locationToken) =>
      context.runProjectOperation("create", () =>
        api.project.create(name.trim(), kind, locationToken),
      ),
    openProject: () => context.runProjectOperation("open", () => api.project.open()),
    openRecentProject: (directory) =>
      context.runProjectOperation("open-recent", () => api.project.openRecent(directory)),
    importMedia: async () => {
      const blocked = context.blockedByProjectOpening<DesktopProjectSession | null>();
      if (blocked) return blocked;
      set({ operationError: null });
      try {
        const session = await api.project.importMedia();
        if (session) context.acceptMutationSession(session);
        return { ok: true, value: session };
      } catch (error) {
        const message = messageFrom(error, "The media could not be imported");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
    execute: async (command) => {
      const blocked = context.blockedByProjectOpening<DesktopProjectSession>();
      if (blocked) return blocked;
      set({ operationError: null });
      try {
        const response = await api.project.execute(
          command,
          sessionFromLifecycle(get().project)?.generation,
        );
        context.acceptMutationSession(response.session);
        return { ok: true, value: response.session };
      } catch (error) {
        const message = messageFrom(error, "The edit could not be applied");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
    appendAsset: async (assetId, sequenceId) => {
      const session = sessionFromLifecycle(get().project);
      const sequence = session?.project.sequences.find((candidate) => candidate.id === sequenceId);
      const asset = session?.project.assets.find((candidate) => candidate.id === assetId);
      if (!session || !sequence || !asset) {
        const error = "The selected asset or timeline is no longer available";
        set({ operationError: error });
        return { ok: false, error };
      }
      const track = sequence.tracks.find(
        (candidate) => !candidate.locked && isAssetCompatibleWithTrack(asset.kind, candidate.kind),
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
    undo: () => context.runSessionAction(() => api.project.undo(), "The edit could not be undone"),
    redo: () => context.runSessionAction(() => api.project.redo(), "The edit could not be redone"),
    save: () =>
      context.runSessionAction(() => api.project.save(), "The project could not be saved"),
    forgetProject: async (directory) => {
      try {
        const appState = await api.project.forget(directory);
        set({ appState, operationError: null });
        return { ok: true, value: appState };
      } catch (error) {
        const message = messageFrom(error, "The project could not be forgotten");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
    trashProject: async (directory) => {
      const session = sessionFromLifecycle(get().project);
      const deletingCurrent = session?.directory === directory;
      if (deletingCurrent) {
        set({
          project: { status: "idle" },
          destination: "home",
          activeSequenceId: null,
          selectedAssetIds: [],
          selectedClipId: null,
          playbackRuntime: null,
          derivedMedia: null,
          operationError: null,
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      try {
        const appState = await api.project.trash(directory);
        set({ appState, operationError: null });
        return { ok: true, value: appState };
      } catch (error) {
        const message = messageFrom(error, "The project could not be moved to Trash");
        if (deletingCurrent) {
          try {
            const reopened = await api.project.openRecent(directory);
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
        playheadUs: timeUs(0),
        playbackRuntime: null,
      });
    },
    setSelectedAssetIds: (assetIds) => set({ selectedAssetIds: [...new Set(assetIds)] }),
    setSettingsSection: (settingsSection) => set({ settingsSection }),
    setAuxiliaryMode: (auxiliaryMode) => {
      storage?.setItem("cinesim.agentsSidebarOpen", String(auxiliaryMode === "agents"));
      set({ auxiliaryMode });
    },
    togglePanel: async (panel) => {
      const blocked = context.blockedByProjectOpening<DesktopAppState>();
      if (blocked) return blocked;
      const key = `${panel}Open` as "mediaPoolOpen" | "inspectorOpen" | "notesOpen";
      const previous = get()[key];
      const next = !previous;
      set({ [key]: next } as Pick<RendererState, typeof key>);
      try {
        const appState = await (panel === "mediaPool"
          ? api.appState.setMediaPoolOpen(next)
          : panel === "inspector"
            ? api.appState.setInspectorOpen(next)
            : api.appState.setNotesOpen(next));
        set({ appState });
        return { ok: true, value: appState };
      } catch (error) {
        const message = messageFrom(error, "The panel preference could not be saved");
        if (get()[key] === next) set({ [key]: previous } as Pick<RendererState, typeof key>);
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
    saveEditorLayout: (layout) =>
      saveAppState(
        context,
        () => api.appState.setEditorLayout(layout),
        "The editor layout could not be saved",
      ),
    saveCutLayout: (layout) =>
      saveAppState(
        context,
        () => api.appState.setCutLayout(layout),
        "The Cut layout could not be saved",
      ),
    saveTranscriptionSettings: async (settings) => {
      if (get().account.status !== "signed-in")
        return { ok: false, error: "Sign in to change transcription settings" };
      return saveAppState(
        context,
        () => api.appState.setTranscriptionSettings(settings),
        "Transcription settings could not be saved",
      );
    },
    reportError: (operationError) => set({ operationError }),
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
    updateProjectSettings: async (update) => {
      try {
        const session = await api.project.updateSettings(update);
        context.acceptMutationSession(session);
        return { ok: true, value: session };
      } catch (error) {
        const message = messageFrom(error, "The project settings could not be updated");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
  };
}

async function saveAppState(
  context: RendererStoreContext,
  operation: () => Promise<DesktopAppState>,
  fallback: string,
) {
  const blocked = context.blockedByProjectOpening<DesktopAppState>();
  if (blocked) return blocked;
  try {
    const appState = await operation();
    context.set({ appState });
    return { ok: true as const, value: appState };
  } catch (error) {
    const message = messageFrom(error, fallback);
    context.set({ operationError: message });
    return { ok: false as const, error: message };
  }
}

import type { AssetId } from "@cinesim/core";
import { messageFrom, sessionFromLifecycle } from "./renderer-project-state";
import type { PlaybackMediaSlice } from "./renderer-state";
import type { RendererStoreContext } from "./renderer-store-coordinator";

export function createPlaybackMediaSlice(context: RendererStoreContext): PlaybackMediaSlice {
  const { api, get, set } = context;
  return {
    playbackRuntime: null,
    derivedMedia: null,
    transcripts: null,
    electronHealth: null,
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
    setTranscripts: (projectDirectory, transcripts) => {
      const session = sessionFromLifecycle(get().project);
      if (session?.directory !== projectDirectory) return;
      const current = get().transcripts;
      if (!transcripts || !current) {
        set({ transcripts });
        return;
      }
      const assets = structuredClone(transcripts.assets);
      for (const [assetId, record] of Object.entries(assets)) {
        const retained = current.assets[assetId as AssetId]?.artifact;
        if (record?.state === "ready" && !record.artifact && retained) record.artifact = retained;
      }
      set({ transcripts: { ...transcripts, assets } });
    },
    loadTranscripts: async (assetIds) => {
      const session = sessionFromLifecycle(get().project);
      if (!session) return { ok: false, error: "Open a project before loading transcripts" };
      try {
        const snapshot = await api.transcripts.get(session.derivedScope, assetIds);
        get().setTranscripts(session.directory, snapshot);
        return { ok: true, value: get().transcripts ?? snapshot };
      } catch (error) {
        return { ok: false, error: messageFrom(error, "Timeline transcripts could not be loaded") };
      }
    },
    requestTranscripts: async (assetIds) => {
      const session = sessionFromLifecycle(get().project);
      if (!session) return { ok: false, error: "Open a project before transcribing media" };
      if (get().account.status !== "signed-in" || !get().account.transcription) {
        const error = "Sign in to transcribe media";
        set({ operationError: error });
        return { ok: false, error };
      }
      try {
        const snapshot = await api.transcripts.requestJobs(session.derivedScope, assetIds);
        set({ transcripts: snapshot, operationError: null });
        return { ok: true, value: snapshot };
      } catch (error) {
        const message = messageFrom(error, "Transcription could not be queued");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
    regenerateTranscripts: async (assetIds) => {
      const session = sessionFromLifecycle(get().project);
      if (!session) return { ok: false, error: "Open a project before regenerating transcripts" };
      if (get().account.status !== "signed-in" || !get().account.transcription) {
        const error = "Sign in to transcribe media";
        set({ operationError: error });
        return { ok: false, error };
      }
      try {
        const snapshot = await api.transcripts.regenerateJobs(session.derivedScope, assetIds);
        set({ transcripts: snapshot, operationError: null });
        return { ok: true, value: snapshot };
      } catch (error) {
        const message = messageFrom(error, "Transcription could not be regenerated");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
    cancelTranscripts: async (assetIds) => {
      const session = sessionFromLifecycle(get().project);
      if (!session) return { ok: false, error: "Open a project before canceling transcripts" };
      try {
        const snapshot = await api.transcripts.cancelJobs(session.derivedScope, assetIds);
        get().setTranscripts(session.directory, snapshot);
        return { ok: true, value: snapshot };
      } catch (error) {
        const message = messageFrom(error, "Transcription could not be canceled");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
    setElectronHealth: (electronHealth) => set({ electronHealth }),
  };
}

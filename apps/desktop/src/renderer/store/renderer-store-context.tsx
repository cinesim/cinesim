import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { DesktopApi } from "../../shared/contracts";
import { DEFAULT_TRANSCRIPTION_SETTINGS } from "../../shared/contracts";
import { MediaJobCoordinator } from "../lib/media-job-coordinator";
import {
  createRendererStore,
  sessionFromLifecycle,
  type RendererState,
  type RendererStoreApi,
} from "./renderer-store";

const RendererStoreContext = createContext<RendererStoreApi | null>(null);

export function RendererControllerProvider({
  api,
  children,
}: {
  api: DesktopApi;
  children: React.ReactNode;
}) {
  const [store] = useState(() =>
    createRendererStore({
      api,
      storage: localStorage,
    }),
  );

  return (
    <RendererStoreContext value={store}>
      <RendererControllerEffects api={api} store={store} />
      {children}
    </RendererStoreContext>
  );
}

function RendererControllerEffects({ api, store }: { api: DesktopApi; store: RendererStoreApi }) {
  const project = useStore(store, (state) => sessionFromLifecycle(state.project)?.project ?? null);
  const projectDirectory = useStore(
    store,
    (state) => sessionFromLifecycle(state.project)?.directory ?? null,
  );
  const derivedCacheKey = useStore(
    store,
    (state) => sessionFromLifecycle(state.project)?.derivedScope.cacheKey ?? null,
  );
  const derivedEpoch = useStore(
    store,
    (state) => sessionFromLifecycle(state.project)?.derivedScope.epoch ?? null,
  );
  const acceptedGeneration = useStore(
    store,
    (state) => sessionFromLifecycle(state.project)?.generation ?? null,
  );
  const acceptedProgram = useStore(
    store,
    (state) => sessionFromLifecycle(state.project)?.program ?? null,
  );
  const projectSettingsKey = useStore(store, (state) =>
    JSON.stringify(sessionFromLifecycle(state.project)?.settings ?? null),
  );
  const foregroundPressure = useStore(store, (state) =>
    state.timelineDragging
      ? "dragging"
      : (state.playbackRuntime?.snapshot.foregroundPressure ?? "idle"),
  );
  const transcriptionSettings = useStore(store, (state) => state.appState.transcriptionSettings);
  const transcriptionAvailable = useStore(
    store,
    (state) => state.account.status === "signed-in" && state.account.transcription,
  );
  const effectiveTranscriptionSettings = transcriptionAvailable
    ? transcriptionSettings
    : DEFAULT_TRANSCRIPTION_SETTINGS;
  const mediaJobsRef = useRef<MediaJobCoordinator | null>(null);
  const projectRef = useRef(project);
  const acceptedGenerationRef = useRef(acceptedGeneration);
  const acceptedProgramRef = useRef(acceptedProgram);

  useEffect(() => {
    projectRef.current = project;
    acceptedGenerationRef.current = acceptedGeneration;
    acceptedProgramRef.current = acceptedProgram;
  }, [acceptedGeneration, acceptedProgram, project]);

  useEffect(() => {
    void store.getState().initialize();
    const unsubscribeProject = api.project.onChanged((session) => {
      void store.getState().receiveExternalSession(session);
    });
    const unsubscribeAccount = api.account.onChanged((snapshot) => {
      store.getState().setAccount(snapshot);
    });
    const unsubscribeCloud = api.cloud.onTransfersChanged((snapshot) => {
      store.getState().setCloudTransfers(snapshot);
    });
    const unsubscribeTranscripts = api.transcripts.onChanged((snapshot) => {
      store.getState().setTranscripts(snapshot.projectDirectory, snapshot);
    });
    return () => {
      unsubscribeProject();
      unsubscribeAccount();
      unsubscribeCloud();
      unsubscribeTranscripts();
    };
  }, [api, store]);

  useEffect(() => {
    const initialProject = projectRef.current;
    const projectSettings = sessionFromLifecycle(store.getState().project)?.settings;
    if (
      !initialProject ||
      !projectSettings ||
      !projectDirectory ||
      !derivedCacheKey ||
      !derivedEpoch
    )
      return;
    const coordinator = new MediaJobCoordinator(
      initialProject,
      { cacheKey: derivedCacheKey, epoch: derivedEpoch },
      (snapshot) => store.getState().setDerivedMedia(projectDirectory, snapshot),
      {
        settings: projectSettings,
        onTranscriptSnapshot: (snapshot) =>
          store.getState().setTranscripts(projectDirectory, snapshot),
        transcriptionSettings: DEFAULT_TRANSCRIPTION_SETTINGS,
        acceptedGeneration: acceptedGenerationRef.current ?? "",
        program: acceptedProgramRef.current,
      },
    );
    mediaJobsRef.current = coordinator;
    void coordinator.start().catch(() => {
      if (mediaJobsRef.current === coordinator) {
        mediaJobsRef.current = null;
        store.getState().setDerivedMedia(projectDirectory, null);
        store.getState().setTranscripts(projectDirectory, null);
      }
      void coordinator.destroy();
    });
    return () => {
      mediaJobsRef.current = null;
      store.getState().setDerivedMedia(projectDirectory, null);
      store.getState().setTranscripts(projectDirectory, null);
      void coordinator.destroy();
    };
  }, [derivedCacheKey, derivedEpoch, projectDirectory, store]);

  useEffect(() => {
    const projectSettings = sessionFromLifecycle(store.getState().project)?.settings;
    if (project && projectSettings)
      void mediaJobsRef.current
        ?.updateProject(project, projectSettings, acceptedGeneration ?? "", acceptedProgram)
        .catch(() => undefined);
  }, [acceptedGeneration, acceptedProgram, project, projectSettingsKey, store]);

  useEffect(() => {
    void mediaJobsRef.current
      ?.updateTranscriptionSettings(effectiveTranscriptionSettings)
      .catch(() => undefined);
  }, [effectiveTranscriptionSettings]);

  useEffect(() => {
    mediaJobsRef.current?.setForegroundPressure(foregroundPressure);
  }, [foregroundPressure]);

  useEffect(() => {
    let expectedProbeAt = performance.now() + 100;
    let rendererLagSamples: number[] = [];
    let requestInFlight = false;
    let destroyed = false;
    const probe = window.setInterval(() => {
      const now = performance.now();
      rendererLagSamples.push(Math.max(0, now - expectedProbeAt));
      if (rendererLagSamples.length > 20) rendererLagSamples.shift();
      expectedProbeAt = now + 100;
    }, 100);
    const sample = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      const sortedLagSamples = rendererLagSamples.toSorted((left, right) => left - right);
      const rendererEventLoopLagMs =
        sortedLagSamples[Math.max(0, Math.ceil(sortedLagSamples.length * 0.95) - 1)] ?? 0;
      rendererLagSamples = [];
      try {
        const snapshot = await api.health.get();
        if (!destroyed) store.getState().setElectronHealth({ ...snapshot, rendererEventLoopLagMs });
      } catch {
        if (!destroyed) store.getState().setElectronHealth(null);
      }
      requestInFlight = false;
    };
    void sample();
    const sampler = window.setInterval(() => void sample(), 1_000);
    return () => {
      destroyed = true;
      window.clearInterval(probe);
      window.clearInterval(sampler);
    };
  }, [api, store]);

  return null;
}

export function useRendererStoreApi(): RendererStoreApi {
  const store = useContext(RendererStoreContext);
  if (!store) throw new Error("Renderer store is unavailable outside RendererControllerProvider");
  return store;
}

export function useRendererStore<T>(selector: (state: RendererState) => T): T {
  return useStore(useRendererStoreApi(), selector);
}

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { DesktopApi } from "../../shared/api";
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
  const projectSettingsKey = useStore(store, (state) =>
    JSON.stringify(sessionFromLifecycle(state.project)?.settings ?? null),
  );
  const foregroundPressure = useStore(store, (state) =>
    state.timelineDragging
      ? "dragging"
      : (state.playbackRuntime?.snapshot.foregroundPressure ?? "idle"),
  );
  const mediaJobsRef = useRef<MediaJobCoordinator | null>(null);
  const projectRef = useRef(project);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    void store.getState().initialize();
    const unsubscribeProject = api.onProjectChanged((session) => {
      void store.getState().receiveExternalSession(session);
    });
    const unsubscribeAccount = api.onAccountChanged((snapshot) => {
      store.getState().setAccount(snapshot);
    });
    const unsubscribeCloud = api.onCloudTransfersChanged((snapshot) => {
      store.getState().setCloudTransfers(snapshot);
    });
    return () => {
      unsubscribeProject();
      unsubscribeAccount();
      unsubscribeCloud();
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
      projectSettings,
    );
    mediaJobsRef.current = coordinator;
    void coordinator.start().catch(() => {
      if (mediaJobsRef.current === coordinator) {
        mediaJobsRef.current = null;
        store.getState().setDerivedMedia(projectDirectory, null);
      }
      void coordinator.destroy();
    });
    return () => {
      mediaJobsRef.current = null;
      store.getState().setDerivedMedia(projectDirectory, null);
      void coordinator.destroy();
    };
  }, [derivedCacheKey, derivedEpoch, projectDirectory, store]);

  useEffect(() => {
    const projectSettings = sessionFromLifecycle(store.getState().project)?.settings;
    if (project && projectSettings)
      void mediaJobsRef.current?.updateProject(project, projectSettings).catch(() => undefined);
  }, [project, projectSettingsKey, store]);

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
        const snapshot = await api.getElectronHealthSnapshot();
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

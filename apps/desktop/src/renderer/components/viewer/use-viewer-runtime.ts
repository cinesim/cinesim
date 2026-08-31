import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Project, TimeUs } from "@cinesim/core";
import { PlaybackRuntime, WebGpuCompositor } from "@cinesim/engine";
import type { PlaybackProject, ShuttleDirection } from "@cinesim/engine";
import type { IrProgram } from "@cinesim/ir";
import type { DerivedProjectScope } from "../../../shared/contracts";
import { ProxySourceResolver } from "../../lib/proxy-source-resolver";
import { useRendererStore, useRendererStoreApi } from "../../store/renderer-store-context";

export interface ViewerController {
  seekTimeline(timeUs: TimeUs): Promise<void>;
  enterAssetPreview(assetId: `asset_${string}`, sourceTimeUs: TimeUs): void;
  exitAssetPreview(): Promise<void>;
  playTimeline(): void;
  pauseTimeline(): void;
  shuttle(direction: ShuttleDirection): void;
  stepFrames(deltaFrames: number): Promise<void>;
}

interface UseViewerRuntimeOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  derivedScope: DerivedProjectScope;
  onController?: (controller: ViewerController | null) => void;
  project: Project;
  program: IrProgram;
  projectDirectory: string;
  sequenceId: string;
}

export function useViewerRuntime({
  canvasRef,
  derivedScope,
  onController,
  project,
  program,
  projectDirectory,
  sequenceId,
}: UseViewerRuntimeOptions) {
  const { cacheKey, epoch } = derivedScope;
  const playbackRef = useRef<PlaybackRuntime | null>(null);
  const projectRef = useRef<PlaybackProject>({
    program: { ...program, activeCompositionId: sequenceId },
    assets: project.assets,
  });
  const store = useRendererStoreApi();
  const reportError = useRendererStore((state) => state.reportError);
  const runtime = useRendererStore((state) =>
    state.playbackRuntime?.projectDirectory === projectDirectory &&
    state.playbackRuntime.sequenceId === sequenceId
      ? state.playbackRuntime.snapshot
      : null,
  );
  const setRuntime = useRendererStore((state) => state.setPlaybackRuntime);

  useEffect(() => {
    projectRef.current = {
      program: { ...program, activeCompositionId: sequenceId },
      assets: project.assets,
    };
    playbackRef.current?.setProject(projectRef.current);
  }, [cacheKey, epoch, program, project.assets, projectDirectory, sequenceId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reportPlaybackError = (caught: Error) => reportError(caught.message);
    const compositor = new WebGpuCompositor(canvas, { onError: reportPlaybackError });
    const playback = new PlaybackRuntime(projectRef.current, compositor, {
      sourceResolver: new ProxySourceResolver(
        { cacheKey, epoch },
        () => store.getState().derivedMedia,
      ),
      onError: reportPlaybackError,
    });
    playbackRef.current = playback;
    onController?.(playback);
    let previousPresented = 0;
    let previousReceived = 0;
    let previousCoalesced = 0;
    let previousObsolete = 0;
    let lastObservationAt = 0;
    const unsubscribe = playback.subscribe((snapshot) => {
      setRuntime(projectDirectory, sequenceId, snapshot);
      const now = performance.now();
      const minimumInterval = snapshot.playing ? 1_000 : 250;
      if (
        snapshot.activeAssetId &&
        snapshot.activeSourceKind &&
        snapshot.framesPresented > previousPresented &&
        (snapshot.playing || snapshot.mode.kind === "asset") &&
        now - lastObservationAt >= minimumInterval
      ) {
        void window.cinesim.derived
          .reportPerformance(
            { cacheKey, epoch },
            {
              assetId: snapshot.activeAssetId,
              sourceKind: snapshot.activeSourceKind,
              operation: snapshot.mode.kind === "asset" ? "hover-seek" : "playback",
              ...(snapshot.mode.kind === "asset" ? { latencyMs: snapshot.seekLatencyMs } : {}),
              ...(snapshot.playing
                ? { deadlineMiss: snapshot.renderFps < snapshot.targetFps * 0.95 }
                : {}),
              requestsReceived: snapshot.requestsReceived - previousReceived,
              requestsCoalesced: snapshot.requestsCoalesced - previousCoalesced,
              framesPresented: snapshot.framesPresented - previousPresented,
              framesObsolete: snapshot.framesObsolete - previousObsolete,
            },
          )
          .catch(() => undefined);
        lastObservationAt = now;
        previousPresented = snapshot.framesPresented;
        previousReceived = snapshot.requestsReceived;
        previousCoalesced = snapshot.requestsCoalesced;
        previousObsolete = snapshot.framesObsolete;
      }
    });
    void playback
      .initialize()
      .catch((caught) =>
        reportPlaybackError(
          caught instanceof Error ? caught : new Error("WebGPU initialization failed"),
        ),
      );
    return () => {
      unsubscribe();
      playback.destroy();
      compositor.destroy();
      playbackRef.current = null;
      setRuntime(projectDirectory, sequenceId, null);
      onController?.(null);
    };
  }, [
    cacheKey,
    canvasRef,
    epoch,
    onController,
    projectDirectory,
    reportError,
    sequenceId,
    setRuntime,
    store,
  ]);

  return { playbackRef, runtime };
}

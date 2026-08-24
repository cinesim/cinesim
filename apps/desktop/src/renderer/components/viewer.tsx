import { useEffect, useRef, useState } from "react";
import { Maximize2, Pause, Play, SkipBack } from "lucide-react";
import { Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, PaneHeader } from "@cinesim/ui";
import { getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import type { DerivedProjectScope } from "../../shared/api";
import { PlaybackRuntime, WebGpuCompositor } from "@cinesim/engine";
import { formatTimecode } from "../lib/format";
import { useRendererStore, useRendererStoreApi } from "../store/renderer-store-context";
import { AdaptiveSourceResolver } from "../media/adaptive-source-resolver";

export interface ViewerController {
  seekTimeline(timeUs: number): Promise<void>;
  enterAssetPreview(assetId: `asset_${string}`, sourceTimeUs: number): void;
  updateAssetPreview(sourceTimeUs: number): void;
  exitAssetPreview(): Promise<void>;
}

export function Viewer({
  project,
  projectDirectory,
  derivedScope,
  sequenceId,
  onController,
}: {
  project: Project;
  projectDirectory: string;
  derivedScope: DerivedProjectScope;
  sequenceId: string;
  onController?: (controller: ViewerController | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { cacheKey: derivedCacheKey, epoch: derivedEpoch } = derivedScope;
  const runtimeRef = useRef<PlaybackRuntime | null>(null);
  const initialProjectRef = useRef(project);
  const [error, setError] = useState<string | null>(null);
  const store = useRendererStoreApi();
  const runtime = useRendererStore((state) =>
    state.playbackRuntime?.projectDirectory === projectDirectory &&
    state.playbackRuntime.sequenceId === sequenceId
      ? state.playbackRuntime.snapshot
      : null,
  );
  const setRuntime = useRendererStore((state) => state.setPlaybackRuntime);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const sequence = getSequence(project);
  const durationUs = sequenceDurationUs(sequence);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reportPlaybackError = (caught: Error) => setError(caught.message);
    const compositor = new WebGpuCompositor(canvas, { onError: reportPlaybackError });
    const playback = new PlaybackRuntime(initialProjectRef.current, compositor, {
      sourceResolver: new AdaptiveSourceResolver(
        { cacheKey: derivedCacheKey, epoch: derivedEpoch },
        () => store.getState().derivedMedia,
      ),
      onError: reportPlaybackError,
    });
    runtimeRef.current = playback;
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
        void window.cinesim
          .reportDerivedPerformance(
            { cacheKey: derivedCacheKey, epoch: derivedEpoch },
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
      runtimeRef.current = null;
      setRuntime(projectDirectory, sequenceId, null);
      onController?.(null);
    };
  }, [
    derivedCacheKey,
    derivedEpoch,
    onController,
    projectDirectory,
    sequenceId,
    setRuntime,
    store,
  ]);

  useEffect(() => runtimeRef.current?.setProject(project), [project]);

  async function seek(value: number) {
    await runtimeRef.current?.seek(Math.round(value));
  }

  return (
    <section className="relative flex min-h-0 flex-col bg-panel-muted">
      <PaneHeader size="sm" className="justify-between px-3">
        <span className="ml-auto rounded bg-surface px-2 py-1 text-ui-xs text-muted tabular-nums">
          {sequence.width} × {sequence.height} · {sequence.frameRate} fps
        </span>
      </PaneHeader>
      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-canvas p-6">
        <canvas ref={canvasRef} className="aspect-video max-h-full max-w-full bg-black" />
        {durationUs === 0 && (
          <Empty className="pointer-events-none absolute">
            <EmptyHeader>
              <EmptyTitle>
                {project.assets.length === 0 ? "The viewer is ready" : "This timeline is empty"}
              </EmptyTitle>
              <EmptyDescription>
                {project.assets.length === 0
                  ? "Import media and add it to the timeline"
                  : "Add media from the Media Pool to start editing"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {error && (
          <div className="absolute bottom-3 max-w-md rounded-md border border-border-strong bg-panel/90 px-3 py-2 text-ui-xs text-primary">
            {error}
          </div>
        )}
      </div>
      <div className="grid h-12 grid-cols-[1fr_auto_1fr] items-center border-t border-border px-3">
        <span className="text-ui-xs text-secondary tabular-nums">
          {formatTimecode(playheadUs, sequence.frameRate)}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Go to beginning"
            onClick={() => void seek(0)}
          >
            <SkipBack size={14} />
          </Button>
          <Button
            className="rounded-full"
            size="icon"
            variant="secondary"
            aria-label={runtime?.playing ? "Pause" : "Play"}
            onClick={() =>
              runtime?.playing ? runtimeRef.current?.pause() : runtimeRef.current?.play()
            }
          >
            {runtime?.playing ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play className="ml-0.5" size={15} fill="currentColor" />
            )}
          </Button>
        </div>
        <Button className="ml-auto" size="icon" variant="ghost" aria-label="Fullscreen viewer">
          <Maximize2 size={14} />
        </Button>
      </div>
      <input
        aria-label="Viewer playhead"
        className="viewer-scrubber absolute bottom-11 left-0 right-0 z-10 h-1 w-full cursor-ew-resize appearance-none bg-transparent"
        type="range"
        min={0}
        max={Math.max(1, durationUs)}
        value={Math.min(playheadUs, durationUs)}
        onChange={(event) => void seek(Number(event.target.value))}
      />
    </section>
  );
}

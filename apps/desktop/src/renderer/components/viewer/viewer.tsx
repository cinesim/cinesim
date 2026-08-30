import { useEffect, useRef, useState } from "react";
import { Check, Grid3X3, Maximize2 } from "@cinesim/ui";
import {
  Button,
  cn,
  DropdownSelect,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  PaneHeader,
} from "@cinesim/ui";
import { getSequence, sequenceDurationUs, timeUs } from "@cinesim/core";
import type { Project, TimeUs } from "@cinesim/core";
import type { DerivedProjectScope } from "../../../shared/api";
import { PlaybackRuntime, WebGpuCompositor } from "@cinesim/engine";
import type { PreviewMode } from "@cinesim/engine";
import { ProxySourceResolver } from "../../lib/proxy-source-resolver";
import { useRendererStore, useRendererStoreApi } from "../../store/renderer-store-context";

export interface ViewerController {
  seekTimeline(timeUs: TimeUs): Promise<void>;
  enterAssetPreview(assetId: `asset_${string}`, sourceTimeUs: TimeUs): void;
  updateAssetPreview(sourceTimeUs: TimeUs): void;
  exitAssetPreview(): Promise<void>;
  playTimeline(): void;
  pauseTimeline(): void;
  stepFrames(deltaFrames: number): Promise<void>;
}

type ViewerScale = "fit" | "0.5" | "1" | "2";

const VIEWER_SCALE_OPTIONS: ReadonlyArray<{ value: ViewerScale; label: string }> = [
  { value: "fit", label: "Fit" },
  { value: "0.5", label: "50%" },
  { value: "1", label: "100%" },
  { value: "2", label: "200%" },
];

interface ViewerGuides {
  grid: boolean;
  rows: number;
  columns: number;
  center: boolean;
  actionSafe: boolean;
  titleSafe: boolean;
}

const DEFAULT_GUIDES: ViewerGuides = {
  grid: false,
  rows: 3,
  columns: 3,
  center: false,
  actionSafe: false,
  titleSafe: false,
};

function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(
    target.closest('input, textarea, select, button, a[href], [role="button"], [role="menuitem"]'),
  );
}

export function viewerDisplaySize(
  source: { width: number; height: number },
  stage: { width: number; height: number },
  scale: ViewerScale,
  padding = 40,
): { width: number; height: number } {
  const safeWidth = Math.max(1, source.width);
  const safeHeight = Math.max(1, source.height);
  const factor =
    scale === "fit"
      ? Math.min(
          1,
          Math.max(1, stage.width - padding) / safeWidth,
          Math.max(1, stage.height - padding) / safeHeight,
        )
      : Number(scale);
  return {
    width: Math.max(1, Math.round(safeWidth * factor)),
    height: Math.max(1, Math.round(safeHeight * factor)),
  };
}

export function shouldShowTimelineEmptyState(
  durationUs: number,
  mode: { kind: "timeline" | "asset" } | null,
): boolean {
  return durationUs === 0 && mode?.kind !== "asset";
}

export function steppedSourceTimeUs(
  currentTimeUs: TimeUs,
  durationUs: TimeUs,
  frameRate: number,
  deltaFrames: number,
): TimeUs {
  const safeRate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 30;
  const frameCount = Math.max(1, Math.ceil((durationUs * safeRate) / 1_000_000));
  const currentFrame = Math.max(
    0,
    Math.floor((Math.max(0, currentTimeUs) * safeRate) / 1_000_000 + 0.000_1),
  );
  const targetFrame = Math.max(0, Math.min(currentFrame + deltaFrames, frameCount - 1));
  return timeUs(Math.min(durationUs, Math.round((targetFrame * 1_000_000) / safeRate)));
}

function stepDisplayedFrame(
  playback: PlaybackRuntime,
  project: Project,
  mode: PreviewMode | undefined,
  deltaFrames: number,
): void {
  if (mode?.kind !== "asset") {
    void playback.stepFrames(deltaFrames);
    return;
  }
  const asset = project.assets.find((candidate) => candidate.id === mode.assetId);
  if (!asset) return;
  const frameRate = asset.frameRate ?? getSequence(project).frameRate;
  playback.enterAssetPreview(
    asset.id,
    steppedSourceTimeUs(mode.sourceTimeUs, asset.durationUs, frameRate, deltaFrames),
  );
}

function goToDisplayedStart(playback: PlaybackRuntime, mode: PreviewMode | undefined): void {
  if (mode?.kind === "asset") playback.enterAssetPreview(mode.assetId, timeUs(0));
  else void playback.seekTimeline(timeUs(0));
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
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { cacheKey: derivedCacheKey, epoch: derivedEpoch } = derivedScope;
  const runtimeRef = useRef<PlaybackRuntime | null>(null);
  const projectRef = useRef(project);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [viewerScale, setViewerScale] = useState<ViewerScale>("fit");
  const [guides, setGuides] = useState(DEFAULT_GUIDES);
  const store = useRendererStoreApi();
  const runtime = useRendererStore((state) =>
    state.playbackRuntime?.projectDirectory === projectDirectory &&
    state.playbackRuntime.sequenceId === sequenceId
      ? state.playbackRuntime.snapshot
      : null,
  );
  const setRuntime = useRendererStore((state) => state.setPlaybackRuntime);
  const sequence = getSequence(project);
  const durationUs = sequenceDurationUs(sequence);
  const displaySize = viewerDisplaySize(sequence, stageSize, viewerScale);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reportPlaybackError = (caught: Error) => setError(caught.message);
    const compositor = new WebGpuCompositor(canvas, { onError: reportPlaybackError });
    const playback = new PlaybackRuntime(projectRef.current, compositor, {
      sourceResolver: new ProxySourceResolver(
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
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
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

  useEffect(
    () => runtimeRef.current?.setProject(projectRef.current),
    [derivedCacheKey, derivedEpoch, project, projectDirectory, sequenceId],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const resize = () => {
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (displaySize.width <= 1 || displaySize.height <= 1) return;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void runtimeRef.current?.refresh();
    }, 100);
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [displaySize.height, displaySize.width]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent): void {
      if (
        isInteractiveShortcutTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.repeat
      )
        return;
      const playback = runtimeRef.current;
      if (!playback) return;
      const snapshot = store.getState().playbackRuntime?.snapshot;
      const key = event.key.toLowerCase();
      if (event.code === "Space") {
        event.preventDefault();
        const playing = store.getState().playbackRuntime?.snapshot.playing ?? false;
        if (playing) playback.pause();
        else playback.setPlaybackRate(1);
      } else if (key === "j") {
        event.preventDefault();
        playback.shuttle(-1);
      } else if (key === "k") {
        event.preventDefault();
        playback.shuttle(0);
      } else if (key === "l") {
        event.preventDefault();
        playback.shuttle(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepDisplayedFrame(playback, projectRef.current, snapshot?.mode, -1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepDisplayedFrame(playback, projectRef.current, snapshot?.mode, 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        goToDisplayedStart(playback, snapshot?.mode);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [store]);

  async function toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await sectionRef.current?.requestFullscreen();
  }

  return (
    <section
      ref={sectionRef}
      className="viewer-panel relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel-muted"
    >
      <PaneHeader size="sm" className="min-w-0 gap-2 overflow-hidden px-3">
        <span className="min-w-0 flex-1" />
        {runtime?.playing && Math.abs(runtime.playbackRate) !== 1 && (
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-secondary tabular-nums">
            {runtime.playbackRate > 0 ? "+" : "−"}
            {Math.abs(runtime.playbackRate)}×
          </span>
        )}
        {runtime?.activeSourceKind && (
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            {runtime.activeSourceKind === "proxy" ? "Proxy" : "Original"}
          </span>
        )}
        <DropdownSelect
          aria-label="Viewer zoom"
          className="viewer-zoom w-[76px] shrink-0"
          options={VIEWER_SCALE_OPTIONS}
          value={viewerScale}
          onValueChange={setViewerScale}
        />
        <GuideMenu guides={guides} onChange={setGuides} />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Fullscreen viewer"
          title="Fullscreen viewer"
          onClick={() => void toggleFullscreen()}
        >
          <Maximize2 size={14} />
        </Button>
        <span className="viewer-resolution shrink-0 rounded bg-surface px-2 py-1 text-ui-xs text-muted tabular-nums">
          {sequence.width} × {sequence.height} · {sequence.frameRate} fps
        </span>
      </PaneHeader>
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto bg-canvas">
        <div
          className="grid place-items-center p-5"
          style={{
            minWidth: "100%",
            minHeight: "100%",
            width: displaySize.width + 40,
            height: displaySize.height + 40,
          }}
        >
          <div
            className="relative shrink-0 overflow-hidden bg-black shadow-xl shadow-black/15"
            style={{ width: displaySize.width, height: displaySize.height }}
          >
            <canvas ref={canvasRef} className="block h-full w-full bg-black" />
            <ViewerGuideOverlay guides={guides} />
          </div>
        </div>
        {shouldShowTimelineEmptyState(durationUs, runtime?.mode ?? null) && (
          <Empty className="pointer-events-none absolute inset-0">
            <EmptyHeader>
              <EmptyTitle>
                {project.assets.length === 0 ? "The viewer is ready" : "This timeline is empty"}
              </EmptyTitle>
              <EmptyDescription>
                {project.assets.length === 0
                  ? "Import media and add it to the timeline"
                  : "Drag media from the Media Pool onto a timeline track"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {error && (
          <div className="absolute bottom-3 left-1/2 max-w-md -translate-x-1/2 rounded-md border border-border-strong bg-panel/90 px-3 py-2 text-ui-xs text-primary">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}

function GuideMenu({
  guides,
  onChange,
}: {
  guides: ViewerGuides;
  onChange: (guides: ViewerGuides) => void;
}) {
  function toggle(key: "grid" | "center" | "actionSafe" | "titleSafe"): void {
    onChange({ ...guides, [key]: !guides[key] });
  }

  return (
    <Menu>
      <MenuTrigger
        aria-label="Viewer guides"
        title="Viewer guides"
        className={cn(
          "grid size-8 place-items-center rounded-md text-secondary hover:bg-surface hover:text-primary",
          Object.values(guides).some((value) => value === true) && "bg-surface text-primary",
        )}
      >
        <Grid3X3 size={14} />
      </MenuTrigger>
      <MenuContent align="end" className="w-56 p-2">
        <MenuGroup>
          <MenuLabel>Composition guides</MenuLabel>
          <GuideToggle active={guides.grid} label="Grid" onClick={() => toggle("grid")} />
          <GuideToggle active={guides.center} label="Center" onClick={() => toggle("center")} />
          <GuideToggle
            active={guides.actionSafe}
            label="Action safe"
            onClick={() => toggle("actionSafe")}
          />
          <GuideToggle
            active={guides.titleSafe}
            label="Title safe"
            onClick={() => toggle("titleSafe")}
          />
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border pt-2">
            <label className="grid gap-1 text-ui-xs text-muted">
              Columns
              <input
                className="h-8 rounded-md border border-border bg-panel-muted px-2 text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus"
                type="number"
                min={1}
                max={12}
                value={guides.columns}
                onChange={(event) =>
                  onChange({
                    ...guides,
                    columns: Math.min(12, Math.max(1, Number(event.target.value) || 1)),
                  })
                }
              />
            </label>
            <label className="grid gap-1 text-ui-xs text-muted">
              Rows
              <input
                className="h-8 rounded-md border border-border bg-panel-muted px-2 text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus"
                type="number"
                min={1}
                max={12}
                value={guides.rows}
                onChange={(event) =>
                  onChange({
                    ...guides,
                    rows: Math.min(12, Math.max(1, Number(event.target.value) || 1)),
                  })
                }
              />
            </label>
          </div>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

function GuideToggle({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <MenuItem
      closeOnClick={false}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-secondary hover:bg-surface hover:text-primary"
      onClick={onClick}
    >
      <span className="grid size-4 place-items-center">{active && <Check size={13} />}</span>
      {label}
    </MenuItem>
  );
}

function ViewerGuideOverlay({ guides }: { guides: ViewerGuides }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 text-white/55 [filter:drop-shadow(0_0_1px_rgb(0_0_0/0.9))]"
    >
      {guides.grid && (
        <>
          {Array.from({ length: Math.max(0, guides.columns - 1) }, (_, index) => (
            <span
              key={`column:${index}`}
              className="absolute inset-y-0 w-px bg-current"
              style={{ left: `${((index + 1) / guides.columns) * 100}%` }}
            />
          ))}
          {Array.from({ length: Math.max(0, guides.rows - 1) }, (_, index) => (
            <span
              key={`row:${index}`}
              className="absolute inset-x-0 h-px bg-current"
              style={{ top: `${((index + 1) / guides.rows) * 100}%` }}
            />
          ))}
        </>
      )}
      {guides.center && (
        <>
          <span className="absolute inset-y-0 left-1/2 w-px bg-current" />
          <span className="absolute inset-x-0 top-1/2 h-px bg-current" />
        </>
      )}
      {guides.actionSafe && <span className="absolute inset-[5%] border border-current" />}
      {guides.titleSafe && <span className="absolute inset-[10%] border border-current" />}
    </div>
  );
}

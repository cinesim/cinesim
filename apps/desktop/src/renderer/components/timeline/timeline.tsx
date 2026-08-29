import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pause, Play } from "lucide-react";
import { canSplitClipAt, getSequence, sequenceDurationUs } from "@cinesim/core";
import type { EditorCommand, Project, TimelineRange } from "@cinesim/core";
import {
  AudioLines,
  Button,
  Layers,
  Magnet,
  Menu,
  MenuContent,
  MenuGroup,
  MenuIcon,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  MousePointer2,
  MoveHorizontal,
  Plus,
  Scissors,
  Separator,
  Trash2,
  Video,
  ZoomIn,
  ZoomOut,
} from "@cinesim/ui";
import type { TranscriptSnapshot } from "../../../shared/transcript";
import { timelinePresentationForHeight } from "../../../shared/transcript";
import { formatTimecode } from "../../lib/format";
import {
  BASE_TIMELINE_PIXELS_PER_SECOND,
  MAX_TIMELINE_ZOOM,
  timelineContentDurationUs,
  timelineFitZoom,
  timelineMajorSecondStep,
} from "../../lib/timeline-scale";
import type { ActionResult } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { MasterLevelMeter } from "./master-level-meter";
import { ReducedTimeline } from "./reduced-timeline";
import {
  FULL_TIMELINE_TRACK_CHROME_WIDTH,
  isTimelinePaletteId,
  TIMELINE_PALETTES,
} from "./timeline-behavior";
import type { TimelinePaletteId } from "./timeline-behavior";
import { TimelineTrackHeader, TimelineTrackRow } from "./timeline-track";

export { fadeDurationFromDrag } from "./timeline-behavior";
export type { TimelinePaletteId } from "./timeline-behavior";

interface TimelineProps {
  project: Project;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  onSeek?: (timeUs: number) => void;
  onTogglePlayback?: () => void;
  onGoToStart?: () => void;
  onStepFrames?: (deltaFrames: number) => void;
  transcripts?: TranscriptSnapshot | null;
  selectedRanges?: TimelineRange[];
}

export function Timeline({
  project,
  onCommand,
  onSeek,
  onTogglePlayback,
  onGoToStart,
  onStepFrames,
  transcripts = null,
  selectedRanges = [],
}: TimelineProps) {
  const zoom = useRendererStore((state) => state.timelineZoom);
  const setZoom = useRendererStore((state) => state.setTimelineZoom);
  const trackHeight = useRendererStore((state) => state.timelineTrackHeight);
  const setTrackHeight = useRendererStore((state) => state.setTimelineTrackHeight);
  const tool = useRendererStore((state) => state.tool);
  const setTool = useRendererStore((state) => state.setTool);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const selectClip = useRendererStore((state) => state.selectClip);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const setPlayheadUs = useRendererStore((state) => state.setPlayheadUs);
  const snappingEnabled = useRendererStore((state) => state.snappingEnabled);
  const toggleSnapping = useRendererStore((state) => state.toggleSnapping);
  const derived = useRendererStore((state) => state.derivedMedia);
  const playback = useRendererStore((state) => state.playbackRuntime?.snapshot ?? null);
  const [paletteId, setPaletteId] = useState<TimelinePaletteId>(() => {
    const stored = localStorage.getItem("cinesim.timelinePalette");
    return isTimelinePaletteId(stored) ? stored : "northern-lights";
  });
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [timelineRootWidth, setTimelineRootWidth] = useState(0);
  const [renderedHeight, setRenderedHeight] = useState(288);
  const rootRef = useRef<HTMLElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const sequence = getSequence(project);
  const sequenceDuration = sequenceDurationUs(sequence);
  const minimumZoom = timelineFitZoom(
    sequenceDuration,
    Math.max(0, timelineRootWidth - FULL_TIMELINE_TRACK_CHROME_WIDTH),
  );
  const pixelsPerUs = (BASE_TIMELINE_PIXELS_PER_SECOND * zoom) / 1_000_000;
  const contentDurationUs = timelineContentDurationUs(sequenceDuration);
  const contentWidth = Math.max(timelineViewportWidth, Math.round(contentDurationUs * pixelsPerUs));
  const assets = useMemo(
    () => new Map(project.assets.map((asset) => [asset.id, asset])),
    [project.assets],
  );
  const selectedClip = selectedClipId
    ? sequence.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId)
    : undefined;
  const canSplitSelection = Boolean(selectedClip && canSplitClipAt(selectedClip, playheadUs));
  const presentation = timelinePresentationForHeight(renderedHeight);

  function selectPalette(next: TimelinePaletteId): void {
    setPaletteId(next);
    localStorage.setItem("cinesim.timelinePalette", next);
  }

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      setRenderedHeight(root.clientHeight);
      setTimelineRootWidth(root.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = timelineScrollRef.current;
    if (!viewport) return;
    const measure = () => setTimelineViewportWidth(viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [presentation]);

  useEffect(() => {
    if (zoom < minimumZoom) setZoom(minimumZoom);
  }, [minimumZoom, setZoom, zoom]);

  function rulerSeek(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scrollParent = event.currentTarget.parentElement!;
    const x = event.clientX - bounds.left + scrollParent.scrollLeft;
    const timeUs = Math.max(0, Math.round(x / pixelsPerUs));
    setPlayheadUs(timeUs);
    onSeek?.(timeUs);
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture(event.pointerId);
  }

  function trackSeek(event: React.PointerEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const timeUs = Math.max(0, Math.round((event.clientX - bounds.left) / pixelsPerUs));
    setPlayheadUs(timeUs);
    onSeek?.(timeUs);
  }

  const majorSecondStep = timelineMajorSecondStep(zoom);
  const tickCount = Math.ceil(contentDurationUs / 1_000_000 / majorSecondStep);

  if (presentation !== "full") {
    return (
      <section
        ref={rootRef}
        className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel-muted"
      >
        <ReducedTimeline
          project={project}
          transcripts={transcripts}
          selectedRanges={selectedRanges}
          playheadUs={playheadUs}
          playing={playback?.playing ?? false}
          paletteId={paletteId}
          zoom={zoom}
          minimumZoom={minimumZoom}
          pixelsPerUs={pixelsPerUs}
          contentWidth={contentWidth}
          scrollRef={timelineScrollRef}
          onZoomChange={setZoom}
          onSeek={(timeUs) => {
            setPlayheadUs(timeUs);
            onSeek?.(timeUs);
          }}
          {...(onTogglePlayback ? { onTogglePlayback } : {})}
          {...(onGoToStart ? { onGoToStart } : {})}
          {...(onStepFrames ? { onStepFrames } : {})}
        />
      </section>
    );
  }

  return (
    <section ref={rootRef} className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel-muted">
      <div className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border bg-panel px-2">
        <div className="flex min-w-0 items-center gap-0.5">
          <Button
            size="icon"
            variant={tool === "select" ? "secondary" : "ghost"}
            aria-label="Selection tool"
            title="Selection tool (V)"
            onClick={() => setTool("select")}
          >
            <MousePointer2 size={14} />
          </Button>
          <Button
            size="icon"
            variant={tool === "trim" ? "secondary" : "ghost"}
            aria-label="Trim tool"
            title="Trim tool (T)"
            onClick={() => setTool("trim")}
          >
            <MoveHorizontal size={14} />
          </Button>
          <Button
            size="icon"
            variant={tool === "blade" ? "secondary" : "ghost"}
            aria-label="Blade tool"
            title="Blade tool (B)"
            onClick={() => setTool("blade")}
          >
            <Scissors size={14} />
          </Button>
          <Separator orientation="vertical" className="mx-1 h-4 self-auto" />
          <Menu>
            <MenuTrigger
              aria-label="Add timeline track"
              title="Add timeline track"
              className="grid size-8 place-items-center rounded-md text-secondary hover:bg-surface hover:text-primary"
            >
              <Plus size={14} />
            </MenuTrigger>
            <MenuContent align="start" className="w-48">
              <MenuGroup>
                <MenuLabel>Add track</MenuLabel>
                <MenuItem
                  onClick={() =>
                    void onCommand({ type: "track.add", sequenceId: sequence.id, kind: "video" })
                  }
                >
                  <Video size={14} /> Video track
                </MenuItem>
                <MenuItem
                  onClick={() =>
                    void onCommand({ type: "track.add", sequenceId: sequence.id, kind: "audio" })
                  }
                >
                  <AudioLines size={14} /> Audio track
                </MenuItem>
                <MenuItem
                  onClick={() =>
                    void onCommand({ type: "track.add", sequenceId: sequence.id, kind: "overlay" })
                  }
                >
                  <Layers size={14} /> Overlay track
                </MenuItem>
              </MenuGroup>
            </MenuContent>
          </Menu>
          <Menu>
            <MenuTrigger
              aria-label="Timeline view options"
              title="Timeline view options"
              className="grid size-8 place-items-center rounded-md text-secondary hover:bg-surface hover:text-primary"
            >
              <MenuIcon size={14} />
            </MenuTrigger>
            <MenuContent align="start" className="w-60 p-2">
              <MenuGroup>
                <MenuLabel>Track appearance</MenuLabel>
                <label className="grid gap-1 px-2 py-1 text-ui-xs text-muted">
                  Height
                  <input
                    aria-label="Timeline track height"
                    className="h-1 accent-accent"
                    type="range"
                    min={40}
                    max={112}
                    step={4}
                    value={trackHeight}
                    onChange={(event) => setTrackHeight(Number(event.target.value))}
                  />
                </label>
                <MenuLabel>Clip palette</MenuLabel>
                {TIMELINE_PALETTES.map((palette) => (
                  <MenuItem key={palette.id} onClick={() => selectPalette(palette.id)}>
                    <span className="flex gap-0.5">
                      {Object.values(palette.colors).map((color) => (
                        <span
                          key={color}
                          className="size-2 rounded-full"
                          style={{ background: color }}
                        />
                      ))}
                    </span>
                    <span className="flex-1">{palette.name}</span>
                    {paletteId === palette.id && <span aria-hidden="true">✓</span>}
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuContent>
          </Menu>
          <Button
            size="icon"
            variant={snappingEnabled ? "secondary" : "ghost"}
            aria-label={snappingEnabled ? "Disable snapping" : "Enable snapping"}
            aria-pressed={snappingEnabled}
            title="Snapping (S)"
            onClick={toggleSnapping}
          >
            <Magnet size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Split selected clip"
            disabled={!canSplitSelection}
            onClick={() =>
              selectedClipId &&
              canSplitSelection &&
              void onCommand({ type: "clip.split", clipId: selectedClipId, atUs: playheadUs })
            }
          >
            <Scissors size={14} />
          </Button>
          <Button
            size="icon"
            variant="danger"
            aria-label="Delete selected clip"
            disabled={!selectedClipId}
            onClick={() =>
              selectedClipId &&
              void onCommand({ type: "clip.remove", clipId: selectedClipId }).then((result) => {
                if (result.ok) selectClip(null);
              })
            }
          >
            <Trash2 size={14} />
          </Button>
        </div>

        <div className="flex h-full items-center gap-1">
          <span className="mr-2 inline-flex h-9 min-w-[100px] items-center justify-center px-2 text-center text-[13px] leading-none font-semibold text-primary tabular-nums">
            {formatTimecode(playheadUs, sequence.frameRate)}
          </span>
          <Button
            size="icon-lg"
            variant="ghost"
            aria-label="Go to timeline beginning"
            title="Go to beginning (Home)"
            onClick={onGoToStart}
          >
            <ChevronsLeft size={20} strokeWidth={1.8} />
          </Button>
          <Button
            size="icon-lg"
            variant="ghost"
            aria-label="Previous frame"
            title="Previous frame (Left Arrow)"
            onClick={() => onStepFrames?.(-1)}
          >
            <ChevronLeft size={20} strokeWidth={1.8} />
          </Button>
          <Button
            size="icon-lg"
            variant="ghost"
            aria-label={playback?.playing ? "Pause" : "Play"}
            title="Play or pause (Space)"
            onClick={onTogglePlayback}
          >
            {playback?.playing ? (
              <Pause size={20} fill="currentColor" strokeWidth={1.8} />
            ) : (
              <Play className="ml-0.5" size={20} fill="currentColor" strokeWidth={1.8} />
            )}
          </Button>
          <Button
            size="icon-lg"
            variant="ghost"
            aria-label="Next frame"
            title="Next frame (Right Arrow)"
            onClick={() => onStepFrames?.(1)}
          >
            <ChevronRight size={20} strokeWidth={1.8} />
          </Button>
          <Button
            size="icon-lg"
            variant="ghost"
            aria-label="Go to timeline end"
            title="Go to end (End)"
            onClick={() => onSeek?.(sequenceDuration)}
          >
            <ChevronsRight size={20} strokeWidth={1.8} />
          </Button>
          {playback?.playing && Math.abs(playback.playbackRate) !== 1 && (
            <span className="px-1 text-[9px] font-semibold text-muted tabular-nums">
              {playback.playbackRate > 0 ? "+" : "−"}
              {Math.abs(playback.playbackRate)}×
            </span>
          )}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom out"
            disabled={zoom <= minimumZoom + Number.EPSILON}
            onClick={() => setZoom(Math.max(minimumZoom, zoom / 1.25))}
          >
            <ZoomOut size={13} />
          </Button>
          <input
            aria-label="Timeline zoom"
            className="h-1 w-20 accent-accent"
            type="range"
            min={minimumZoom}
            max={MAX_TIMELINE_ZOOM}
            step="any"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom in"
            onClick={() => setZoom(zoom * 1.25)}
          >
            <ZoomIn size={13} />
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[168px_minmax(0,1fr)_72px] overflow-hidden">
        <div
          ref={headerScrollRef}
          className="relative z-20 overflow-hidden border-r border-border bg-panel"
          onWheel={(event) => {
            if (timelineScrollRef.current) timelineScrollRef.current.scrollTop += event.deltaY;
          }}
        >
          <div className="sticky top-0 z-20 h-6 border-b border-border bg-panel" />
          {sequence.tracks.map((track, index) => (
            <TimelineTrackHeader
              key={track.id}
              track={track}
              index={index}
              total={sequence.tracks.length}
              height={trackHeight}
              onCommand={onCommand}
              paletteId={paletteId}
            />
          ))}
        </div>
        <div
          ref={timelineScrollRef}
          className="timeline-scroll relative min-h-0 overflow-auto"
          onScroll={(event) => {
            if (headerScrollRef.current)
              headerScrollRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
        >
          <div className="relative min-h-full" style={{ width: contentWidth }}>
            <div
              className="sticky top-0 z-20 h-6 cursor-ew-resize border-b border-border bg-panel/95"
              onPointerDown={rulerSeek}
              onPointerMove={(event) => {
                if (event.buttons & 1) rulerSeek(event);
              }}
            >
              {Array.from({ length: tickCount + 1 }, (_, index) => {
                const seconds = index * majorSecondStep;
                return (
                  <div
                    className="absolute bottom-0 h-2 border-l border-border-strong"
                    key={seconds}
                    style={{ left: seconds * 1_000_000 * pixelsPerUs }}
                  >
                    <span className="absolute -top-2 left-1 text-ui-xs text-muted tabular-nums">
                      {seconds}s
                    </span>
                  </div>
                );
              })}
            </div>
            {sequence.tracks.map((track) => (
              <TimelineTrackRow
                key={track.id}
                track={track}
                assets={assets}
                derived={derived}
                pixelsPerUs={pixelsPerUs}
                trackHeight={trackHeight}
                selectedClipId={selectedClipId}
                onCommand={onCommand}
                onBackgroundPointerDown={trackSeek}
                project={project}
                frameRate={sequence.frameRate}
                snappingEnabled={snappingEnabled}
                playheadUs={playheadUs}
                paletteId={paletteId}
              />
            ))}
            {selectedRanges.map((range, index) => (
              <div
                key={`${range.startUs}:${range.endUs}:${index}`}
                className="pointer-events-none absolute bottom-0 top-6 z-20 border-x border-accent bg-accent/15"
                style={{
                  left: range.startUs * pixelsPerUs,
                  width: Math.max(1, (range.endUs - range.startUs) * pixelsPerUs),
                }}
              />
            ))}
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-playhead"
              style={{ left: playheadUs * pixelsPerUs }}
            >
              <div className="-ml-1 h-2 w-2 rounded-b-sm bg-playhead" />
            </div>
          </div>
        </div>
        <MasterLevelMeter />
      </div>
    </section>
  );
}

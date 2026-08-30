import { useMemo, type RefObject } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pause, Play } from "lucide-react";
import { sequenceDurationUs, getSequence, timeUs } from "@cinesim/core";
import type { Project, TimelineRange, TimeUs } from "@cinesim/core";
import { Button, cn, ZoomIn, ZoomOut } from "@cinesim/ui";
import type { TranscriptSnapshot } from "../../../shared/transcript";
import { projectNarrativeUnits } from "../../../shared/transcript";
import { formatTimecode } from "../../lib/format";
import { MAX_TIMELINE_ZOOM } from "../../lib/timeline-scale";
import { useRendererStore } from "../../store/renderer-store-context";
import { timelinePaletteColor } from "./timeline-behavior";
import type { TimelinePaletteId } from "./timeline-behavior";

function rangesIntersect(
  startUs: number,
  endUs: number,
  ranges: readonly TimelineRange[],
): boolean {
  return ranges.some((range) => range.startUs < endUs && range.endUs > startUs);
}

export function ReducedTimeline({
  project,
  transcripts,
  selectedRanges,
  playheadUs,
  playing,
  paletteId,
  zoom,
  minimumZoom,
  pixelsPerUs,
  contentWidth,
  scrollRef,
  onSeek,
  onTogglePlayback,
  onGoToStart,
  onStepFrames,
  onZoomChange,
}: {
  project: Project;
  transcripts: TranscriptSnapshot | null;
  selectedRanges: readonly TimelineRange[];
  playheadUs: TimeUs;
  playing: boolean;
  paletteId: TimelinePaletteId;
  zoom: number;
  minimumZoom: number;
  pixelsPerUs: number;
  contentWidth: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSeek?: (timeUs: TimeUs) => void;
  onTogglePlayback?: () => void;
  onGoToStart?: () => void;
  onStepFrames?: (deltaFrames: number) => void;
  onZoomChange: (zoom: number) => void;
}) {
  const selectClip = useRendererStore((state) => state.selectClip);
  const sequence = getSequence(project);
  const units = useMemo(
    () => projectNarrativeUnits({ project, sequenceId: sequence.id, transcripts }),
    [project, sequence.id, transcripts],
  );
  const clips = useMemo(
    () =>
      new Map(
        sequence.tracks.flatMap((track) =>
          track.clips.map((clip) => [clip.id, { clip, track }] as const),
        ),
      ),
    [sequence.tracks],
  );
  const assets = useMemo(
    () => new Map(project.assets.map((asset) => [asset.id, asset])),
    [project.assets],
  );
  const durationUs = timeUs(Math.max(1, sequenceDurationUs(sequence)));
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-panel-muted">
      <div className="grid h-12 min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border bg-panel px-2">
        <div />
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
            aria-label={playing ? "Pause" : "Play"}
            title="Play or pause (Space)"
            onClick={onTogglePlayback}
          >
            {playing ? (
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
            onClick={() => onSeek?.(durationUs)}
          >
            <ChevronsRight size={20} strokeWidth={1.8} />
          </Button>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom out"
            disabled={zoom <= minimumZoom + Number.EPSILON}
            onClick={() => onZoomChange(Math.max(minimumZoom, zoom / 1.25))}
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
            onChange={(event) => onZoomChange(Number(event.target.value))}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom in"
            onClick={() => onZoomChange(zoom * 1.25)}
          >
            <ZoomIn size={13} />
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-2 py-1.5"
      >
        <div className="relative h-full min-w-full" style={{ width: contentWidth }}>
          {units.length === 0 ? (
            <div className="grid h-full place-items-center text-ui-xs text-muted">
              Add media to build the story timeline
            </div>
          ) : (
            units.map((unit) => {
              const selected = rangesIntersect(
                unit.timelineStartUs,
                unit.timelineEndUs,
                selectedRanges,
              );
              const active = playheadUs >= unit.timelineStartUs && playheadUs < unit.timelineEndUs;
              const unitClips = unit.clipIds.flatMap((clipId) => clips.get(clipId) ?? []);
              const coloredClip =
                unitClips.find(({ track }) => track.kind !== "audio") ?? unitClips[0];
              const color = coloredClip
                ? timelinePaletteColor(
                    paletteId,
                    coloredClip.track,
                    assets.get(coloredClip.clip.assetId),
                  )
                : "var(--ui-clip-video)";
              return (
                <button
                  key={unit.id}
                  type="button"
                  className={cn(
                    "absolute top-0 h-full min-w-2 overflow-hidden rounded-sm border shadow-sm transition-[filter,box-shadow]",
                    selected && "z-10 ring-2 ring-primary",
                    active && "brightness-110",
                    !selected && "hover:brightness-110",
                  )}
                  style={{
                    left: unit.timelineStartUs * pixelsPerUs,
                    width: Math.max(
                      8,
                      (unit.timelineEndUs - unit.timelineStartUs) * pixelsPerUs - 1,
                    ),
                    backgroundColor: color,
                    borderColor: `color-mix(in srgb, ${color} 72%, black)`,
                  }}
                  aria-label={`Story clip at ${formatTimecode(unit.timelineStartUs, sequence.frameRate)}`}
                  title={formatTimecode(unit.timelineStartUs, sequence.frameRate)}
                  onClick={() => {
                    selectClip(unit.clipIds[0] ?? null);
                    onSeek?.(unit.timelineStartUs);
                  }}
                >
                  {selectedRanges.flatMap((range, index) => {
                    const startUs = Math.max(range.startUs, unit.timelineStartUs);
                    const endUs = Math.min(range.endUs, unit.timelineEndUs);
                    if (startUs >= endUs) return [];
                    const duration = unit.timelineEndUs - unit.timelineStartUs;
                    return [
                      <span
                        key={`${range.startUs}:${range.endUs}:${index}`}
                        className="pointer-events-none absolute inset-y-0 bg-white/25"
                        style={{
                          left: `${((startUs - unit.timelineStartUs) / duration) * 100}%`,
                          width: `${((endUs - startUs) / duration) * 100}%`,
                        }}
                      />,
                    ];
                  })}
                </button>
              );
            })
          )}
          <div
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-playhead"
            style={{ left: playheadUs * pixelsPerUs }}
          />
        </div>
      </div>
    </div>
  );
}

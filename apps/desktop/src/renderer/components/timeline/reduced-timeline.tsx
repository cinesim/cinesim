import { useMemo, type RefObject } from "react";
import { sequenceDurationUs, getSequence, timeUs } from "@cinesim/core";
import type { Project, TimelineRange, TimeUs } from "@cinesim/core";
import { cn } from "@cinesim/ui";
import type { TranscriptSnapshot } from "../../../shared/transcript";
import { projectNarrativeUnits } from "../../../shared/transcript";
import { formatTimecode } from "../../lib/format";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorTransport } from "../workspace/editor-transport-context";
import { timelinePaletteColor } from "./timeline-behavior";
import type { TimelinePaletteId } from "./timeline-behavior";
import { TimelineZoomControls } from "./timeline-toolbar";
import { TimelineTransport } from "./timeline-transport";

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
  playbackRate,
  paletteId,
  zoom,
  minimumZoom,
  pixelsPerUs,
  contentWidth,
  scrollRef,
  onZoomChange,
  onFitToWidth,
}: {
  project: Project;
  transcripts: TranscriptSnapshot | null;
  selectedRanges: readonly TimelineRange[];
  playheadUs: TimeUs;
  playing: boolean;
  playbackRate: number;
  paletteId: TimelinePaletteId;
  zoom: number;
  minimumZoom: number;
  pixelsPerUs: number;
  contentWidth: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onZoomChange: (zoom: number) => void;
  onFitToWidth: () => void;
}) {
  const selectClip = useRendererStore((state) => state.selectClip);
  const transport = useEditorTransport();
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
        <TimelineTransport
          durationUs={durationUs}
          frameRate={sequence.frameRate}
          playbackRate={playbackRate}
          playheadUs={playheadUs}
          playing={playing}
        />
        <TimelineZoomControls
          minimumZoom={minimumZoom}
          zoom={zoom}
          onChange={onZoomChange}
          onFit={onFitToWidth}
        />
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
                    void transport.seekTimeline(unit.timelineStartUs);
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

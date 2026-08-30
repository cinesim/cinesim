import { useMemo, useState } from "react";
import { canSplitClipAt, getSequence, sequenceDurationUs, timeUs } from "@cinesim/core";
import type { Project, TimelineRange } from "@cinesim/core";
import { timelineMajorSecondStep } from "../../lib/timeline-scale";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorTransport } from "../workspace/editor-transport-context";
import { MasterLevelMeter } from "./master-level-meter";
import { ReducedTimeline } from "./reduced-timeline";
import { isTimelinePaletteId } from "./timeline-behavior";
import type { TimelinePaletteId } from "./timeline-behavior";
import { TimelineEditToolbar, TimelineZoomControls } from "./timeline-toolbar";
import { TimelineTrackHeader, TimelineTrackRow } from "./timeline-track";
import { TimelineTransport } from "./timeline-transport";
import { useTimelineViewport } from "./use-timeline-viewport";

export { fadeDurationFromDrag } from "./timeline-behavior";
export type { TimelinePaletteId } from "./timeline-behavior";

interface TimelineProps {
  project: Project;
  selectedRanges?: TimelineRange[];
}

export function Timeline({ project, selectedRanges = [] }: TimelineProps) {
  const execute = useRendererStore((state) => state.execute);
  const zoom = useRendererStore((state) => state.timelineZoom);
  const setZoom = useRendererStore((state) => state.setTimelineZoom);
  const trackHeight = useRendererStore((state) => state.timelineTrackHeight);
  const setTrackHeight = useRendererStore((state) => state.setTimelineTrackHeight);
  const tool = useRendererStore((state) => state.tool);
  const setTool = useRendererStore((state) => state.setTool);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const selectClip = useRendererStore((state) => state.selectClip);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const snappingEnabled = useRendererStore((state) => state.snappingEnabled);
  const toggleSnapping = useRendererStore((state) => state.toggleSnapping);
  const derived = useRendererStore((state) => state.derivedMedia);
  const transcripts = useRendererStore((state) => state.transcripts);
  const playback = useRendererStore((state) => state.playbackRuntime?.snapshot ?? null);
  const transport = useEditorTransport();
  const [paletteId, setPaletteId] = useState<TimelinePaletteId>(() => {
    const stored = localStorage.getItem("cinesim.timelinePalette");
    return isTimelinePaletteId(stored) ? stored : "northern-lights";
  });
  const sequence = getSequence(project);
  const sequenceDuration = sequenceDurationUs(sequence);
  const {
    changeZoom,
    contentDurationUs,
    contentWidth,
    fitToWidth,
    headerScrollRef,
    minimumZoom,
    pixelsPerUs,
    presentation,
    rootRef,
    scrollRef,
    scrollTracksFromHeader,
    syncHeaderScroll,
  } = useTimelineViewport({
    onZoomChange: setZoom,
    playheadUs,
    sequenceDurationUs: sequenceDuration,
    zoom,
  });
  const assets = useMemo(
    () => new Map(project.assets.map((asset) => [asset.id, asset])),
    [project.assets],
  );
  const selectedClip = selectedClipId
    ? sequence.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId)
    : undefined;
  const canSplitSelection = Boolean(selectedClip && canSplitClipAt(selectedClip, playheadUs));

  function selectPalette(next: TimelinePaletteId): void {
    setPaletteId(next);
    localStorage.setItem("cinesim.timelinePalette", next);
  }

  function rulerSeek(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scrollParent = event.currentTarget.parentElement!;
    const x = event.clientX - bounds.left + scrollParent.scrollLeft;
    const seekTimeUs = timeUs(Math.max(0, Math.round(x / pixelsPerUs)));
    void transport.seekTimeline(seekTimeUs);
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture(event.pointerId);
  }

  function trackSeek(event: React.PointerEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const seekTimeUs = timeUs(Math.max(0, Math.round((event.clientX - bounds.left) / pixelsPerUs)));
    void transport.seekTimeline(seekTimeUs);
  }

  const majorSecondStep = timelineMajorSecondStep(zoom);
  const tickCount = Math.floor(contentDurationUs / 1_000_000 / majorSecondStep);

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
          playbackRate={playback?.playbackRate ?? 1}
          paletteId={paletteId}
          zoom={zoom}
          minimumZoom={minimumZoom}
          pixelsPerUs={pixelsPerUs}
          contentWidth={contentWidth}
          scrollRef={scrollRef}
          onZoomChange={changeZoom}
          onFitToWidth={fitToWidth}
        />
      </section>
    );
  }

  return (
    <section ref={rootRef} className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel-muted">
      <div className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border bg-panel px-2">
        <TimelineEditToolbar
          canDelete={Boolean(selectedClipId)}
          canSplit={canSplitSelection}
          paletteId={paletteId}
          snappingEnabled={snappingEnabled}
          tool={tool}
          trackHeight={trackHeight}
          onAddTrack={(kind) => void execute({ type: "track.add", sequenceId: sequence.id, kind })}
          onDelete={() => {
            if (!selectedClipId) return;
            void execute({ type: "clip.remove", clipId: selectedClipId }).then((result) => {
              if (result.ok) selectClip(null);
            });
          }}
          onPaletteChange={selectPalette}
          onSnappingToggle={toggleSnapping}
          onSplit={() => {
            if (selectedClipId && canSplitSelection)
              void execute({ type: "clip.split", clipId: selectedClipId, atUs: playheadUs });
          }}
          onToolChange={setTool}
          onTrackHeightChange={setTrackHeight}
        />
        <TimelineTransport
          durationUs={sequenceDuration}
          frameRate={sequence.frameRate}
          playbackRate={playback?.playbackRate ?? 1}
          playheadUs={playheadUs}
          playing={playback?.playing ?? false}
        />
        <TimelineZoomControls
          minimumZoom={minimumZoom}
          zoom={zoom}
          onChange={changeZoom}
          onFit={fitToWidth}
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[168px_minmax(0,1fr)_72px] overflow-hidden">
        <div
          ref={headerScrollRef}
          className="relative z-20 overflow-hidden border-r border-border bg-panel"
          onWheel={scrollTracksFromHeader}
        >
          <div className="sticky top-0 z-20 h-6 border-b border-border bg-panel" />
          {sequence.tracks.map((track, index) => (
            <TimelineTrackHeader
              key={track.id}
              track={track}
              index={index}
              total={sequence.tracks.length}
              height={trackHeight}
              paletteId={paletteId}
            />
          ))}
        </div>
        <div
          ref={scrollRef}
          className="timeline-scroll relative min-h-0 overflow-auto"
          onScroll={syncHeaderScroll}
        >
          <div className="relative min-h-full" style={{ width: contentWidth }}>
            <div
              className="sticky top-0 z-20 h-6 cursor-ew-resize overflow-hidden border-b border-border bg-panel/95"
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

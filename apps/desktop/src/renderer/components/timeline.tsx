import { useEffect, useMemo, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Scissors,
  MousePointer2,
  Trash2,
  ZoomIn,
  ZoomOut,
  Lock,
  Magnet,
  VolumeX,
} from "lucide-react";
import { Button, cn, PaneHeader, Separator } from "@cinesim/ui";
import { clipDurationUs, getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Clip, EditorCommand, Project, Track } from "@cinesim/core";
import {
  IDLE_TRIM_GESTURE,
  trimPreviewRange,
  transitionTrimGesture,
  type TrimGestureState,
} from "../interactions/trim-gesture";
import { formatTimecode } from "../lib/format";
import type { ActionResult } from "../store/renderer-store";
import { useRendererStore } from "../store/renderer-store-context";
import { useEditorDnd } from "../interactions/editor-dnd-context";

const BASE_PIXELS_PER_SECOND = 86;

interface TimelineProps {
  project: Project;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  onSeek?: (timeUs: number) => void;
}

interface ClipBlockProps {
  clip: Clip;
  track: Track;
  pixelsPerUs: number;
  selected: boolean;
  name: string;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
}

function ClipBlock({ clip, track, pixelsPerUs, selected, name, onCommand }: ClipBlockProps) {
  const tool = useRendererStore((state) => state.tool);
  const selectClip = useRendererStore((state) => state.selectClip);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: clip.id,
    data: { kind: "clip", clipId: clip.id, trackId: track.id },
    disabled: track.locked,
  });
  const [trimGesture, setTrimGesture] = useState<TrimGestureState>(IDLE_TRIM_GESTURE);
  const trimGestureRef = useRef<TrimGestureState>(IDLE_TRIM_GESTURE);
  const previewRange = trimPreviewRange(trimGesture);
  const left = (previewRange?.timelineStartUs ?? clip.timelineStartUs) * pixelsPerUs;
  const width = Math.max(
    18,
    (previewRange
      ? previewRange.timelineEndUs - previewRange.timelineStartUs
      : clipDurationUs(clip)) * pixelsPerUs,
  );

  useEffect(
    () => () => {
      trimGestureRef.current = IDLE_TRIM_GESTURE;
    },
    [],
  );

  function trim(which: "start" | "end", event: React.PointerEvent) {
    event.stopPropagation();
    const transition = transitionTrimGesture(trimGestureRef.current, {
      type: "start",
      pointerId: event.pointerId,
      edge: which,
      clientX: event.clientX,
      pixelsPerUs,
      clip,
    });
    trimGestureRef.current = transition.state;
    setTrimGesture(transition.state);
    if (transition.state.status === "trimming")
      event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTrim(event: React.PointerEvent<HTMLButtonElement>) {
    const transition = transitionTrimGesture(trimGestureRef.current, {
      type: "move",
      pointerId: event.pointerId,
      clientX: event.clientX,
    });
    trimGestureRef.current = transition.state;
    setTrimGesture(transition.state);
  }

  function finishTrim(event: React.PointerEvent<HTMLButtonElement>) {
    const transition = transitionTrimGesture(trimGestureRef.current, {
      type: "finish",
      pointerId: event.pointerId,
      clientX: event.clientX,
    });
    trimGestureRef.current = transition.state;
    setTrimGesture(transition.state);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (transition.command) void onCommand(transition.command);
  }

  function cancelTrim(event: React.PointerEvent<HTMLButtonElement>) {
    trimGestureRef.current = transitionTrimGesture(trimGestureRef.current, {
      type: "cancel",
      pointerId: event.pointerId,
    }).state;
    setTrimGesture(trimGestureRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function activate(event: React.MouseEvent<HTMLButtonElement>) {
    selectClip(clip.id);
    if (tool !== "blade") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const atUs = clip.timelineStartUs + Math.round(clipDurationUs(clip) * ratio);
    void onCommand({ type: "clip.split", clipId: clip.id, atUs });
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute top-1 h-11 overflow-hidden rounded-md border text-left shadow-sm outline-none transition-[border-color,filter]",
        track.kind === "audio"
          ? "border-clip-border bg-clip-audio"
          : "border-clip-border bg-clip-video",
        selected && "border-primary ring-1 ring-primary",
        isDragging && "z-30 opacity-35",
        trimGesture.status === "trimming" && "z-30 ring-1 ring-primary",
        tool === "blade" && "cursor-crosshair",
      )}
      style={{
        left,
        width,
      }}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        aria-label={`${selected ? "Selected " : ""}${name} clip`}
        className="absolute inset-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
        onClick={activate}
      >
        <span className="clip-texture pointer-events-none absolute inset-0 opacity-40" />
        <span className="relative block truncate px-2 pt-1.5 text-ui-xs font-medium text-clip-text">
          {name}
        </span>
        <span className="relative block px-2 pt-0.5 text-ui-xs text-clip-text-muted tabular-nums">
          {clip.id}
        </span>
      </button>
      <button
        type="button"
        aria-label="Trim clip start"
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-primary"
        onPointerDown={(event) => trim("start", event)}
        onPointerMove={moveTrim}
        onPointerUp={finishTrim}
        onPointerCancel={cancelTrim}
        onLostPointerCapture={cancelTrim}
      />
      <button
        type="button"
        aria-label="Trim clip end"
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-primary"
        onPointerDown={(event) => trim("end", event)}
        onPointerMove={moveTrim}
        onPointerUp={finishTrim}
        onPointerCancel={cancelTrim}
        onLostPointerCapture={cancelTrim}
      />
    </div>
  );
}

function TimelineTrackRow({
  track,
  assets,
  pixelsPerUs,
  selectedClipId,
  onCommand,
  onBackgroundPointerDown,
}: {
  track: Track;
  assets: Map<string, string>;
  pixelsPerUs: number;
  selectedClipId: Clip["id"] | null;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  onBackgroundPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const selectClip = useRendererStore((state) => state.selectClip);
  const { proposal } = useEditorDnd();
  const { isOver, setNodeRef } = useDroppable({
    id: `track:${track.id}`,
    data: { kind: "timeline-track", trackId: track.id },
  });
  const trackProposal = proposal?.trackId === track.id ? proposal : null;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "timeline-track relative h-[52px] border-b border-border",
        isOver && "bg-surface/55",
      )}
      style={{ backgroundSize: `${pixelsPerUs * 1_000_000}px 100%` }}
    >
      <button
        type="button"
        aria-label={`Seek and deselect clips on ${track.name}`}
        className="absolute inset-0"
        onPointerDown={(event) => {
          selectClip(null);
          onBackgroundPointerDown(event);
        }}
      />
      {track.clips.map((clip) => (
        <ClipBlock
          key={clip.id}
          clip={clip}
          track={track}
          pixelsPerUs={pixelsPerUs}
          selected={selectedClipId === clip.id}
          name={assets.get(clip.assetId) ?? clip.assetId}
          onCommand={onCommand}
        />
      ))}
      {trackProposal && (
        <div
          className={cn(
            "pointer-events-none absolute top-1 z-40 h-11 overflow-hidden rounded-md border-2 px-2 py-1 shadow-lg",
            trackProposal.valid
              ? "border-primary bg-selection/80 text-primary"
              : "border-red-500/80 bg-red-500/15 text-red-700 dark:text-red-300",
          )}
          style={{
            left: trackProposal.timelineStartUs * pixelsPerUs,
            width: Math.max(
              18,
              (trackProposal.timelineEndUs - trackProposal.timelineStartUs) * pixelsPerUs,
            ),
          }}
        >
          <span className="block truncate text-ui-xs font-medium">
            {assets.get(trackProposal.assetId) ?? trackProposal.assetId}
          </span>
          <span className="block truncate text-[10px] opacity-75">
            {trackProposal.valid ? "Drop to place" : trackProposal.reason?.replaceAll("-", " ")}
          </span>
        </div>
      )}
    </div>
  );
}

export function Timeline({ project, onCommand, onSeek }: TimelineProps) {
  const zoom = useRendererStore((state) => state.timelineZoom);
  const setZoom = useRendererStore((state) => state.setTimelineZoom);
  const tool = useRendererStore((state) => state.tool);
  const setTool = useRendererStore((state) => state.setTool);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const selectClip = useRendererStore((state) => state.selectClip);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const setPlayheadUs = useRendererStore((state) => state.setPlayheadUs);
  const snappingEnabled = useRendererStore((state) => state.snappingEnabled);
  const toggleSnapping = useRendererStore((state) => state.toggleSnapping);
  const sequence = getSequence(project);
  const pixelsPerUs = (BASE_PIXELS_PER_SECOND * zoom) / 1_000_000;
  const contentDurationUs = Math.max(sequenceDurationUs(sequence) + 5_000_000, 30_000_000 / zoom);
  const contentWidth = Math.round(contentDurationUs * pixelsPerUs);
  const assets = useMemo(
    () => new Map(project.assets.map((asset) => [asset.id, asset.name])),
    [project.assets],
  );

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

  const majorSecondStep = zoom < 0.6 ? 5 : zoom < 1.5 ? 2 : 1;
  const tickCount = Math.ceil(contentDurationUs / 1_000_000 / majorSecondStep);

  return (
    <section className="flex min-h-0 flex-col bg-panel-muted">
      <PaneHeader size="sm" className="gap-1">
        <Button
          size="icon"
          variant={tool === "select" ? "secondary" : "ghost"}
          aria-label="Selection tool"
          onClick={() => setTool("select")}
        >
          <MousePointer2 size={14} />
        </Button>
        <Button
          size="icon"
          variant={tool === "blade" ? "secondary" : "ghost"}
          aria-label="Blade tool"
          onClick={() => setTool("blade")}
        >
          <Scissors size={14} />
        </Button>
        <Separator orientation="vertical" className="mx-1 h-4 self-auto" />
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
        <Separator orientation="vertical" className="mx-1 h-4 self-auto" />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Split selected clip"
          disabled={!selectedClipId}
          onClick={() =>
            selectedClipId &&
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
        <span className="ml-auto text-ui-xs text-muted tabular-nums">
          {formatTimecode(playheadUs, sequence.frameRate)}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => setZoom(zoom / 1.25)}
        >
          <ZoomOut size={13} />
        </Button>
        <input
          aria-label="Timeline zoom"
          className="h-1 w-20 accent-accent"
          type="range"
          min="0.25"
          max="4"
          step="0.05"
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
      </PaneHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[84px_1fr] overflow-hidden">
        <div className="z-20 border-r border-border bg-panel pt-6">
          {sequence.tracks.map((track) => (
            <div
              key={track.id}
              className="flex h-[52px] items-center gap-1 border-b border-border px-2"
            >
              <span className="min-w-0 flex-1 truncate text-ui-xs font-medium text-muted">
                {track.name}
              </span>
              {track.muted && <VolumeX size={10} className="text-disabled" />}
              {track.locked && <Lock size={10} className="text-disabled" />}
            </div>
          ))}
        </div>
        <div className="timeline-scroll relative min-h-0 overflow-auto">
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
                pixelsPerUs={pixelsPerUs}
                selectedClipId={selectedClipId}
                onCommand={onCommand}
                onBackgroundPointerDown={trackSeek}
              />
            ))}
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-playhead"
              style={{ left: playheadUs * pixelsPerUs }}
            >
              <div className="-ml-1 h-2 w-2 rounded-b-sm bg-playhead" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

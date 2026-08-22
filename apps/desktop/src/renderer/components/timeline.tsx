import { useMemo } from "react";
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { Scissors, MousePointer2, Trash2, ZoomIn, ZoomOut, Lock, VolumeX } from "lucide-react";
import { Button, cn } from "@cinesim/ui";
import {
  clipDurationUs,
  clipEndUs,
  findClip,
  getSequence,
  sequenceDurationUs,
} from "@cinesim/core";
import type { Clip, EditorCommand, Project, Track } from "@cinesim/core";
import { formatTimecode } from "../lib/format";
import { useUiStore } from "../store/ui-store";

const BASE_PIXELS_PER_SECOND = 86;

interface TimelineProps {
  project: Project;
  onCommand: (command: EditorCommand) => Promise<void>;
}

interface ClipBlockProps {
  clip: Clip;
  track: Track;
  pixelsPerUs: number;
  selected: boolean;
  name: string;
  onCommand: (command: EditorCommand) => Promise<void>;
}

function ClipBlock({ clip, track, pixelsPerUs, selected, name, onCommand }: ClipBlockProps) {
  const tool = useUiStore((state) => state.tool);
  const selectClip = useUiStore((state) => state.selectClip);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: clip.id,
    data: { clipId: clip.id, trackId: track.id },
    disabled: track.locked,
  });
  const left = clip.timelineStartUs * pixelsPerUs;
  const width = Math.max(18, clipDurationUs(clip) * pixelsPerUs);

  function trim(which: "start" | "end", event: React.PointerEvent) {
    event.stopPropagation();
    const origin = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const finish = (rawEvent: Event) => {
      const up = rawEvent as PointerEvent;
      const deltaUs = Math.round((up.clientX - origin) / pixelsPerUs);
      const atUs = which === "start" ? clip.timelineStartUs + deltaUs : clipEndUs(clip) + deltaUs;
      void onCommand({
        type: which === "start" ? "clip.trimStart" : "clip.trimEnd",
        clipId: clip.id,
        atUs,
      });
      target.removeEventListener("pointerup", finish);
    };
    target.addEventListener("pointerup", finish);
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
          ? "border-sky-400/25 bg-sky-600/25"
          : "border-violet-400/30 bg-violet-600/35",
        selected && "border-white/60 ring-1 ring-white/25",
        isDragging && "z-30 brightness-125",
        tool === "blade" && "cursor-crosshair",
      )}
      style={{
        left,
        width,
        transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
      }}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        aria-label={`${selected ? "Selected " : ""}${name} clip`}
        className="absolute inset-0 text-left outline-none focus-visible:ring-1 focus-visible:ring-white/70"
        onClick={activate}
      >
        <span className="pointer-events-none absolute inset-0 opacity-20 [background-image:repeating-linear-gradient(90deg,transparent_0,transparent_18px,rgba(255,255,255,.18)_19px)]" />
        <span className="relative block truncate px-2 pt-1.5 text-[10px] font-medium text-white/90">
          {name}
        </span>
        <span className="relative block px-2 pt-0.5 font-mono text-[8px] text-white/45">
          {clip.id}
        </span>
      </button>
      <button
        type="button"
        aria-label="Trim clip start"
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/60"
        onPointerDown={(event) => trim("start", event)}
      />
      <button
        type="button"
        aria-label="Trim clip end"
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/60"
        onPointerDown={(event) => trim("end", event)}
      />
    </div>
  );
}

export function Timeline({ project, onCommand }: TimelineProps) {
  const zoom = useUiStore((state) => state.timelineZoom);
  const setZoom = useUiStore((state) => state.setTimelineZoom);
  const tool = useUiStore((state) => state.tool);
  const setTool = useUiStore((state) => state.setTool);
  const selectedClipId = useUiStore((state) => state.selectedClipId);
  const selectClip = useUiStore((state) => state.selectClip);
  const playheadUs = useUiStore((state) => state.playheadUs);
  const setPlayheadUs = useUiStore((state) => state.setPlayheadUs);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const sequence = getSequence(project);
  const pixelsPerUs = (BASE_PIXELS_PER_SECOND * zoom) / 1_000_000;
  const contentDurationUs = Math.max(sequenceDurationUs(sequence) + 5_000_000, 30_000_000 / zoom);
  const contentWidth = Math.round(contentDurationUs * pixelsPerUs);
  const assets = useMemo(
    () => new Map(project.assets.map((asset) => [asset.id, asset.name])),
    [project.assets],
  );

  async function dragEnd(event: DragEndEvent) {
    const clipId = String(event.active.id) as Clip["id"];
    const clip = findClip(project, clipId).clip;
    const timelineStartUs = Math.max(
      0,
      Math.round(clip.timelineStartUs + event.delta.x / pixelsPerUs),
    );
    if (timelineStartUs !== clip.timelineStartUs)
      await onCommand({ type: "clip.move", clipId, timelineStartUs });
  }

  function rulerSeek(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scrollParent = event.currentTarget.parentElement!;
    const x = event.clientX - bounds.left + scrollParent.scrollLeft;
    setPlayheadUs(Math.max(0, Math.round(x / pixelsPerUs)));
  }

  const majorSecondStep = zoom < 0.6 ? 5 : zoom < 1.5 ? 2 : 1;
  const tickCount = Math.ceil(contentDurationUs / 1_000_000 / majorSecondStep);

  return (
    <section className="flex min-h-0 flex-col border-t border-white/[0.07] bg-[#0d0d10]">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
        <span className="panel-title mr-3">Timeline</span>
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
        <span className="mx-1 h-4 w-px bg-white/[0.08]" />
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
            void onCommand({ type: "clip.remove", clipId: selectedClipId }).then(() =>
              selectClip(null),
            )
          }
        >
          <Trash2 size={14} />
        </Button>
        <span className="ml-auto font-mono text-[10px] text-zinc-500">
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
          className="h-1 w-20 accent-violet-500"
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
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[84px_1fr] overflow-hidden">
        <div className="z-20 border-r border-white/[0.07] bg-[#111115] pt-6">
          {sequence.tracks.map((track) => (
            <div
              key={track.id}
              className="flex h-[52px] items-center gap-1 border-b border-white/[0.05] px-2"
            >
              <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-zinc-500">
                {track.name}
              </span>
              {track.muted && <VolumeX size={10} className="text-zinc-700" />}
              {track.locked && <Lock size={10} className="text-zinc-700" />}
            </div>
          ))}
        </div>
        <div className="timeline-scroll relative min-h-0 overflow-auto">
          <div className="relative min-h-full" style={{ width: contentWidth }}>
            <div
              className="sticky top-0 z-20 h-6 cursor-ew-resize border-b border-white/[0.06] bg-[#111115]/95"
              onPointerDown={rulerSeek}
            >
              {Array.from({ length: tickCount + 1 }, (_, index) => {
                const seconds = index * majorSecondStep;
                return (
                  <div
                    className="absolute bottom-0 h-2 border-l border-white/15"
                    key={seconds}
                    style={{ left: seconds * 1_000_000 * pixelsPerUs }}
                  >
                    <span className="absolute -top-2 left-1 font-mono text-[8px] text-zinc-700">
                      {seconds}s
                    </span>
                  </div>
                );
              })}
            </div>
            <DndContext sensors={sensors} onDragEnd={(event) => void dragEnd(event)}>
              {sequence.tracks.map((track) => (
                <div
                  key={track.id}
                  className="relative h-[52px] border-b border-white/[0.05] [background-image:linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)]"
                  style={{ backgroundSize: `${BASE_PIXELS_PER_SECOND * zoom}px 100%` }}
                >
                  <button
                    type="button"
                    aria-label={`Deselect clips on ${track.name}`}
                    className="absolute inset-0"
                    onClick={() => selectClip(null)}
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
                </div>
              ))}
            </DndContext>
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-red-400 shadow-[0_0_5px_rgba(248,113,113,.5)]"
              style={{ left: playheadUs * pixelsPerUs }}
            >
              <div className="-ml-1 h-2 w-2 rounded-b-sm bg-red-400" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

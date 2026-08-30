import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { getSequence, timeUs } from "@cinesim/core";
import type { Project, TrackId } from "@cinesim/core";
import { cn } from "@cinesim/ui";
import { formatDuration } from "../../lib/format";
import {
  commandForTimelineDrop,
  proposeAssetDrop,
  proposeClipMove,
  timelineSnapCandidates,
  type TimelineDropProposal,
  type TimelineDragInput,
} from "../../lib/timeline-geometry";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "../../lib/timeline-scale";
import { useRendererStore } from "../../store/renderer-store-context";
import { MediaSkimSurface } from "../media/media-skim-surface";
import { useEditorTransport } from "./editor-transport-context";

export type EditorDragData = TimelineDragInput;

export interface TimelineTrackDropData {
  kind: "timeline-track";
  trackId: TrackId;
}

interface EditorDndState {
  active: EditorDragData | null;
  proposal: TimelineDropProposal | null;
  dragging: boolean;
  pixelsPerUs: number;
}

const EditorDndContext = createContext<EditorDndState | null>(null);

function dragData(event: DragStartEvent | DragMoveEvent | DragOverEvent | DragEndEvent) {
  return event.active.data.current as EditorDragData | undefined;
}

function pointerClientX(event: DragMoveEvent | DragOverEvent | DragEndEvent): number | null {
  const activator = event.activatorEvent;
  if ("clientX" in activator && typeof activator.clientX === "number")
    return activator.clientX + event.delta.x;
  const translated = event.active.rect.current.translated;
  return translated ? translated.left + translated.width / 2 : null;
}

export function EditorDndProvider({
  project,
  children,
}: {
  project: Project;
  children: React.ReactNode;
}) {
  const execute = useRendererStore((state) => state.execute);
  const zoom = useRendererStore((state) => state.timelineZoom);
  const snapping = useRendererStore((state) => state.snappingEnabled);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const setTimelineDragging = useRendererStore((state) => state.setTimelineDragging);
  const transport = useEditorTransport();
  const [active, setActive] = useState<EditorDragData | null>(null);
  const [proposal, setProposal] = useState<TimelineDropProposal | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pixelsPerUs = (BASE_TIMELINE_PIXELS_PER_SECOND * zoom) / 1_000_000;

  useEffect(() => () => setTimelineDragging(false), [setTimelineDragging]);

  function proposalFor(event: DragMoveEvent | DragOverEvent | DragEndEvent) {
    const input = dragData(event);
    const target = event.over?.data.current as TimelineTrackDropData | undefined;
    const pointerX = pointerClientX(event);
    if (!input || target?.kind !== "timeline-track" || pointerX === null || !event.over)
      return null;
    const rawPointerTimeUs = timeUs(
      Math.max(0, Math.round((pointerX - event.over.rect.left) / pixelsPerUs)),
    );
    const snapToleranceUs = timeUs(snapping ? Math.round(8 / pixelsPerUs) : 0);
    if (input.kind === "asset") {
      const snapCandidatesUs = [...timelineSnapCandidates(project), playheadUs];
      return proposeAssetDrop(project, input.assetId, target.trackId, rawPointerTimeUs, {
        snapCandidatesUs,
        snapToleranceUs,
      });
    }
    const sequence = getSequence(project);
    const source = sequence.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === input.clipId);
    if (!source) return null;
    const snapCandidatesUs = [...timelineSnapCandidates(project, input.clipId), playheadUs];
    return proposeClipMove(
      project,
      input.clipId,
      target.trackId,
      timeUs(Math.max(0, Math.round(source.timelineStartUs + event.delta.x / pixelsPerUs))),
      { snapCandidatesUs, snapToleranceUs },
    );
  }

  function start(event: DragStartEvent): void {
    const input = dragData(event);
    if (!input) return;
    setActive(input);
    setProposal(null);
    setTimelineDragging(true);
    if (input.kind === "asset") void transport.exitAssetPreview();
  }

  function update(event: DragMoveEvent | DragOverEvent): void {
    setProposal(proposalFor(event));
  }

  function reset(): void {
    setActive(null);
    setProposal(null);
    setTimelineDragging(false);
  }

  function cancel(_event: DragCancelEvent): void {
    reset();
  }

  async function finish(event: DragEndEvent): Promise<void> {
    const input = dragData(event) ?? active;
    // A release outside a current droppable target is a cancellation. Never
    // fall back to a proposal retained from an earlier hover position.
    const finalProposal = proposalFor(event);
    const command = commandForTimelineDrop(project, input, finalProposal);
    reset();
    if (command) await execute(command);
  }

  const value = useMemo(
    () => ({ active, proposal, dragging: active !== null, pixelsPerUs }),
    [active, pixelsPerUs, proposal],
  );
  const activeAsset =
    active?.kind === "asset"
      ? project.assets.find((candidate) => candidate.id === active.assetId)
      : null;

  return (
    <EditorDndContext value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={start}
        onDragMove={update}
        onDragOver={update}
        onDragCancel={cancel}
        onDragEnd={(event) => void finish(event)}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {activeAsset ? (
            <div
              className={cn(
                "w-44 overflow-hidden rounded-lg border bg-panel shadow-2xl",
                proposal?.valid === false ? "border-red-500/70" : "border-border-strong",
              )}
            >
              <div className="aspect-video overflow-hidden bg-surface text-muted">
                <MediaSkimSurface asset={activeAsset} disabled />
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 text-ui-xs">
                <span className="min-w-0 flex-1 truncate font-medium text-primary">
                  {activeAsset.name}
                </span>
                <span className="text-muted tabular-nums">
                  {formatDuration(activeAsset.durationUs)}
                </span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </EditorDndContext>
  );
}

export function useEditorDnd(): EditorDndState {
  const value = useContext(EditorDndContext);
  if (!value) throw new Error("Editor drag state is unavailable outside EditorDndProvider");
  return value;
}

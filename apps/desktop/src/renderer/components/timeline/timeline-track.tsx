import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { Asset, Clip, EditorCommand, Project, Track } from "@cinesim/core";
import {
  Button,
  ChevronDown,
  ChevronUp,
  cn,
  Lock,
  LockOpen,
  Trash2,
  Volume2,
  VolumeX,
} from "@cinesim/ui";
import type { DerivedMediaSnapshot } from "../../../shared/api";
import { timelineSnapCandidates } from "../../lib/timeline-geometry";
import type { ActionResult } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorDnd } from "../workspace/editor-dnd-context";
import { timelinePaletteColor } from "./timeline-behavior";
import type { TimelinePaletteId } from "./timeline-behavior";
import { TimelineClipBlock } from "./timeline-clip";
import { TimelineFilmstrip } from "./timeline-filmstrip";
import { TimelineWaveform } from "./timeline-waveform";

export function TimelineTrackRow({
  track,
  assets,
  derived,
  pixelsPerUs,
  trackHeight,
  selectedClipId,
  onCommand,
  onBackgroundPointerDown,
  project,
  frameRate,
  snappingEnabled,
  playheadUs,
  paletteId,
}: {
  track: Track;
  assets: Map<string, Asset>;
  derived: DerivedMediaSnapshot | null;
  pixelsPerUs: number;
  trackHeight: number;
  selectedClipId: Clip["id"] | null;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  onBackgroundPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  project: Project;
  frameRate: number;
  snappingEnabled: boolean;
  playheadUs: number;
  paletteId: TimelinePaletteId;
}) {
  const selectClip = useRendererStore((state) => state.selectClip);
  const { proposal } = useEditorDnd();
  const { isOver, setNodeRef } = useDroppable({
    id: `track:${track.id}`,
    data: { kind: "timeline-track", trackId: track.id },
  });
  const trackProposal =
    proposal?.trackId === track.id || proposal?.audioTrackId === track.id ? proposal : null;
  const isAudioProposal = trackProposal?.audioTrackId === track.id;
  const proposalAsset = trackProposal ? assets.get(trackProposal.assetId) : undefined;
  const proposalWidth = trackProposal
    ? Math.max(18, (trackProposal.timelineEndUs - trackProposal.timelineStartUs) * pixelsPerUs)
    : 0;

  return (
    <div
      ref={setNodeRef}
      className={cn("timeline-track relative border-b border-border", isOver && "bg-surface/55")}
      style={{ height: trackHeight, backgroundSize: `${pixelsPerUs * 1_000_000}px 100%` }}
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
        <TimelineClipBlock
          key={clip.id}
          clip={clip}
          track={track}
          asset={assets.get(clip.assetId)}
          derived={derived}
          derivedAsset={derived?.assets[clip.assetId]}
          pixelsPerUs={pixelsPerUs}
          selected={selectedClipId === clip.id || selectedClipId === clip.linkedClipId}
          onCommand={onCommand}
          trackHeight={trackHeight}
          frameRate={frameRate}
          snappingEnabled={snappingEnabled}
          snapCandidatesUs={[...timelineSnapCandidates(project, clip.id), playheadUs]}
          paletteId={paletteId}
        />
      ))}
      {trackProposal && (
        <div
          className={cn(
            "pointer-events-none absolute top-0 z-40 overflow-hidden border-2 px-2 py-1 shadow-lg",
            trackProposal.valid
              ? "border-primary bg-selection/80 text-primary"
              : "border-red-500/80 bg-red-500/15 text-red-700 dark:text-red-300",
          )}
          style={{
            left: trackProposal.timelineStartUs * pixelsPerUs,
            width: proposalWidth,
            height: trackHeight,
          }}
        >
          {proposalAsset &&
            proposalAsset.kind !== "audio" &&
            !isAudioProposal &&
            derived?.assets[proposalAsset.id] && (
              <TimelineFilmstrip
                asset={proposalAsset}
                clip={{ sourceStartUs: 0, sourceEndUs: proposalAsset.durationUs }}
                record={derived.assets[proposalAsset.id]!}
                derived={derived}
                width={proposalWidth}
                height={trackHeight}
              />
            )}
          {proposalAsset &&
            isAudioProposal &&
            derived?.assets[proposalAsset.id]?.waveform.state === "ready" && (
              <TimelineWaveform
                asset={proposalAsset}
                clip={{ sourceStartUs: 0, sourceEndUs: proposalAsset.durationUs }}
                artifact={derived.assets[proposalAsset.id]!.waveform}
                derived={derived}
              />
            )}
          <span className="relative block w-fit max-w-[80%] truncate rounded-sm bg-black/35 px-1 text-ui-xs font-medium text-white">
            {proposalAsset?.name ?? trackProposal.assetId}
          </span>
          <span className="relative mt-0.5 block w-fit rounded-sm bg-black/25 px-1 text-[10px] text-white/80">
            {trackProposal.valid ? "Drop to place" : trackProposal.reason?.replaceAll("-", " ")}
          </span>
        </div>
      )}
    </div>
  );
}

export function TimelineTrackHeader({
  track,
  index,
  total,
  height,
  onCommand,
  paletteId,
}: {
  track: Track;
  index: number;
  total: number;
  height: number;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  paletteId: TimelinePaletteId;
}) {
  const [draftName, setDraftName] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renaming = draftName !== null;

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  function commitName(): void {
    const trimmed = (draftName ?? track.name).trim();
    setDraftName(null);
    if (!trimmed || trimmed === track.name) {
      return;
    }
    void onCommand({ type: "track.update", trackId: track.id, name: trimmed });
  }

  const kindLabel = track.kind === "audio" ? "A" : track.kind === "overlay" ? "O" : "V";
  const trackColor = timelinePaletteColor(paletteId, track, undefined);
  return (
    <div
      className="relative grid content-center gap-0.5 border-b border-border px-2"
      style={{ height }}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: trackColor }} />
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="grid size-5 shrink-0 place-items-center rounded bg-surface text-[10px] font-semibold text-muted">
          {kindLabel}
        </span>
        {renaming ? (
          <input
            ref={renameInputRef}
            className="h-6 min-w-0 flex-1 rounded border border-border-strong bg-panel-muted px-1.5 text-[10px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus"
            value={draftName ?? track.name}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitName();
              if (event.key === "Escape") {
                setDraftName(null);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[10px] leading-4 font-medium text-secondary hover:text-primary"
            title={`${track.name} · Double-click to rename`}
            onDoubleClick={() => setDraftName(track.name)}
          >
            {track.name}
          </button>
        )}
      </div>
      <div className="flex items-center gap-0.5 pl-6">
        <Button
          size="icon-sm"
          variant={track.muted ? "secondary" : "ghost"}
          className="size-6"
          aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
          title={track.muted ? "Unmute track" : "Mute track"}
          onClick={() =>
            void onCommand({ type: "track.update", trackId: track.id, muted: !track.muted })
          }
        >
          {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
        </Button>
        <Button
          size="icon-sm"
          variant={track.locked ? "secondary" : "ghost"}
          className="size-6"
          aria-label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
          title={track.locked ? "Unlock track" : "Lock track"}
          onClick={() =>
            void onCommand({ type: "track.update", trackId: track.id, locked: !track.locked })
          }
        >
          {track.locked ? <Lock size={11} /> : <LockOpen size={11} />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6"
          aria-label={`Move ${track.name} up`}
          title="Move track up"
          disabled={track.locked || index === 0}
          onClick={() =>
            void onCommand({ type: "track.reorder", trackId: track.id, index: index - 1 })
          }
        >
          <ChevronUp size={11} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6"
          aria-label={`Move ${track.name} down`}
          title="Move track down"
          disabled={track.locked || index === total - 1}
          onClick={() =>
            void onCommand({ type: "track.reorder", trackId: track.id, index: index + 1 })
          }
        >
          <ChevronDown size={11} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto size-6"
          aria-label={`Remove ${track.name}`}
          title={track.clips.length ? "Empty the track before removing it" : "Remove track"}
          disabled={track.locked || track.clips.length > 0}
          onClick={() => void onCommand({ type: "track.remove", trackId: track.id })}
        >
          <Trash2 size={11} />
        </Button>
      </div>
    </div>
  );
}

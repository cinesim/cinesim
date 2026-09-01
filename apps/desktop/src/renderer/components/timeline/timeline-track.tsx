import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { timeUs } from "@cinesim/core";
import type { Asset, Clip, Project, TimeUs, Track } from "@cinesim/core";
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
import type { DerivedMediaSnapshot } from "../../../shared/contracts";
import type { IrAdjustmentLayer } from "@cinesim/ir";
import { timelineSnapCandidates, type TimelineDropProposal } from "../../lib/timeline-geometry";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorDnd } from "../workspace/editor-dnd-context";
import { timelinePaletteColor } from "./timeline-behavior";
import type { TimelinePaletteId } from "./timeline-behavior";
import { TimelineClipBlock } from "./timeline-clip";
import { TimelineFilmstrip } from "./timeline-filmstrip";
import { TimelineWaveform } from "./timeline-waveform";

export function TimelineTrackRow({
  track,
  adjustments,
  assets,
  clipEditability,
  derived,
  pixelsPerUs,
  trackHeight,
  selectedClipId,
  onBackgroundPointerDown,
  project,
  frameRate,
  snappingEnabled,
  playheadUs,
  paletteId,
}: {
  track: Track;
  adjustments: readonly IrAdjustmentLayer[];
  assets: Map<string, Asset>;
  clipEditability: Map<string, { editable: boolean; generated: boolean }>;
  derived: DerivedMediaSnapshot | null;
  pixelsPerUs: number;
  trackHeight: number;
  selectedClipId: Clip["id"] | null;
  onBackgroundPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  project: Project;
  frameRate: number;
  snappingEnabled: boolean;
  playheadUs: TimeUs;
  paletteId: TimelinePaletteId;
}) {
  const selectClip = useRendererStore((state) => state.selectClip);
  const { proposal } = useEditorDnd();
  const { isOver, setNodeRef } = useDroppable({
    id: `track:${track.id}`,
    data: { kind: "timeline-track", trackId: track.id },
  });
  const trackProposal = proposalForTrack(proposal, track.id);
  const isLinkedProposal = trackProposal?.linkedTrackId === track.id;
  const isAudioProposal = proposalIsAudio(trackProposal, isLinkedProposal, track.id);
  const proposalAsset = proposalAssetFor(trackProposal, assets);
  const proposalStartUs = proposalBoundary(trackProposal, isLinkedProposal, "start");
  const proposalEndUs = proposalBoundary(trackProposal, isLinkedProposal, "end");
  const proposalWidth = proposalPixelWidth(proposalStartUs, proposalEndUs, pixelsPerUs);

  return (
    <div
      ref={setNodeRef}
      className={cn("relative", isOver && "bg-surface/55")}
      style={{ height: trackHeight }}
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
          editable={clipEditability.get(clip.id)?.editable ?? false}
          generated={clipEditability.get(clip.id)?.generated ?? false}
          derived={derived}
          derivedAsset={derived?.assets[clip.assetId]}
          pixelsPerUs={pixelsPerUs}
          selected={selectedClipId === clip.id || selectedClipId === clip.linkedClipId}
          trackHeight={trackHeight}
          frameRate={frameRate}
          snappingEnabled={snappingEnabled}
          snapCandidatesUs={[...timelineSnapCandidates(project, clip.id), playheadUs]}
          paletteId={paletteId}
        />
      ))}
      {adjustments.map((adjustment) => (
        <div
          key={adjustment.id}
          className="pointer-events-none absolute top-1 z-30 h-2 rounded-sm border border-violet-300/80 bg-violet-500/75 shadow-sm"
          style={{
            left: adjustment.timelineStartUs * pixelsPerUs + 1,
            width: Math.max(8, adjustment.durationUs * pixelsPerUs - 2),
          }}
          title={`${adjustment.id} · ${adjustment.scope === "below" ? `${adjustment.depth} track(s) below` : adjustment.targetTrackIds.join(", ")}`}
        />
      ))}
      {trackProposal && (
        <div
          className={cn(
            "pointer-events-none absolute top-0 z-40 overflow-hidden rounded-md border-2 px-2 py-1 shadow-lg",
            trackProposal.valid
              ? "border-primary bg-selection/80 text-primary"
              : "border-red-500/80 bg-red-500/15 text-red-700 dark:text-red-300",
          )}
          style={{
            left: proposalStartUs! * pixelsPerUs + 1,
            top: 2,
            width: Math.max(16, proposalWidth - 2),
            height: Math.max(1, trackHeight - 4),
          }}
        >
          {proposalAsset &&
            proposalAsset.kind !== "audio" &&
            !isAudioProposal &&
            derived?.assets[proposalAsset.id] && (
              <TimelineFilmstrip
                asset={proposalAsset}
                clip={{ sourceStartUs: timeUs(0), sourceEndUs: proposalAsset.durationUs }}
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
                clip={{ sourceStartUs: timeUs(0), sourceEndUs: proposalAsset.durationUs }}
                artifact={derived.assets[proposalAsset.id]!.waveform}
                derived={derived}
                width={Math.max(16, proposalWidth - 2)}
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
  paletteId,
}: {
  track: Track;
  index: number;
  total: number;
  height: number;
  paletteId: TimelinePaletteId;
}) {
  const execute = useRendererStore((state) => state.execute);
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
    void execute({ type: "track.update", trackId: track.id, name: trimmed });
  }

  const kindLabel = trackKindLabel(track.kind);
  const trackColor = timelinePaletteColor(paletteId, track, undefined);
  return (
    <div className="relative grid content-center gap-0.5 px-2" style={{ height }}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="grid size-5 shrink-0 place-items-center rounded text-[10px] font-semibold text-white shadow-sm ring-1 ring-inset ring-white/10"
          style={{ backgroundColor: trackColor }}
        >
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
          variant={toggleVariant(track.muted)}
          className="size-6"
          aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
          title={track.muted ? "Unmute track" : "Mute track"}
          onClick={() =>
            void execute({ type: "track.update", trackId: track.id, muted: !track.muted })
          }
        >
          <TrackVolumeIcon muted={track.muted} />
        </Button>
        <Button
          size="icon-sm"
          variant={toggleVariant(track.locked)}
          className="size-6"
          aria-label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
          title={track.locked ? "Unlock track" : "Lock track"}
          onClick={() =>
            void execute({ type: "track.update", trackId: track.id, locked: !track.locked })
          }
        >
          <TrackLockIcon locked={track.locked} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6"
          aria-label={`Move ${track.name} up`}
          title="Move track up"
          disabled={track.locked || index === 0}
          onClick={() =>
            void execute({ type: "track.reorder", trackId: track.id, index: index - 1 })
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
            void execute({ type: "track.reorder", trackId: track.id, index: index + 1 })
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
          onClick={() => void execute({ type: "track.remove", trackId: track.id })}
        >
          <Trash2 size={11} />
        </Button>
      </div>
    </div>
  );
}

function proposalForTrack(
  proposal: TimelineDropProposal | null,
  trackId: Track["id"],
): TimelineDropProposal | null {
  if (proposal?.trackId === trackId) return proposal;
  if (proposal?.audioTrackId === trackId) return proposal;
  if (proposal?.linkedTrackId === trackId) return proposal;
  return null;
}

function proposalIsAudio(
  proposal: TimelineDropProposal | null,
  linked: boolean,
  trackId: Track["id"],
): boolean {
  if (linked) return proposal?.linkedMediaKind === "audio";
  if (proposal?.kind === "clip") return proposal.mediaKind === "audio";
  return proposal?.audioTrackId === trackId;
}

function proposalAssetFor(
  proposal: TimelineDropProposal | null,
  assets: Map<string, Asset>,
): Asset | undefined {
  return proposal ? assets.get(proposal.assetId) : undefined;
}

function proposalBoundary(
  proposal: TimelineDropProposal | null,
  linked: boolean,
  edge: "start" | "end",
): TimeUs | undefined {
  if (!proposal) return undefined;
  if (linked)
    return edge === "start" ? proposal.linkedTimelineStartUs : proposal.linkedTimelineEndUs;
  return edge === "start" ? proposal.timelineStartUs : proposal.timelineEndUs;
}

function proposalPixelWidth(
  startUs: TimeUs | undefined,
  endUs: TimeUs | undefined,
  pixelsPerUs: number,
): number {
  if (startUs === undefined || endUs === undefined) return 0;
  return Math.max(18, (endUs - startUs) * pixelsPerUs);
}

function trackKindLabel(kind: Track["kind"]): string {
  if (kind === "audio") return "A";
  return kind === "overlay" ? "O" : "V";
}

function toggleVariant(active: boolean): "secondary" | "ghost" {
  return active ? "secondary" : "ghost";
}

function TrackVolumeIcon({ muted }: { muted: boolean }) {
  return muted ? <VolumeX size={11} /> : <Volume2 size={11} />;
}

function TrackLockIcon({ locked }: { locked: boolean }) {
  return locked ? <Lock size={11} /> : <LockOpen size={11} />;
}

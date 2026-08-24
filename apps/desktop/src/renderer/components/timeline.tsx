import { useEffect, useMemo, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Scissors,
  MousePointer2,
  Trash2,
  ZoomIn,
  ZoomOut,
  Lock,
  LockOpen,
  Magnet,
  Menu as MenuIcon,
  MoveHorizontal,
  Plus,
  ChevronUp,
  ChevronDown,
  Video,
  AudioLines,
  Layers,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  Button,
  cn,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  PaneHeader,
  Separator,
} from "@cinesim/ui";
import { canSplitClipAt, clipDurationUs, getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Asset, Clip, EditorCommand, Project, Track } from "@cinesim/core";
import type { DerivedAssetSnapshot, DerivedMediaSnapshot } from "../../shared/api";
import {
  IDLE_TRIM_GESTURE,
  trimPreviewClip,
  trimPreviewRange,
  transitionTrimGesture,
  type TrimGestureState,
} from "../interactions/trim-gesture";
import { formatTimecode } from "../lib/format";
import type { ActionResult } from "../store/renderer-store";
import { useRendererStore } from "../store/renderer-store-context";
import { useEditorDnd } from "../interactions/editor-dnd-context";
import { quantizeToFrame, timelineSnapCandidates } from "../interactions/timeline-geometry";
import { TimelineFilmstrip } from "./timeline-filmstrip";
import { TimelineWaveform } from "./timeline-waveform";

const BASE_PIXELS_PER_SECOND = 86;

function timelineContentDurationUs(sequenceDuration: number, zoom: number): number {
  return Math.max(sequenceDuration + 5_000_000, 30_000_000 / zoom);
}

interface TimelineProps {
  project: Project;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  onSeek?: (timeUs: number) => void;
}

interface ClipBlockProps {
  clip: Clip;
  track: Track;
  asset: Asset | undefined;
  derived: DerivedMediaSnapshot | null;
  derivedAsset: DerivedAssetSnapshot | undefined;
  pixelsPerUs: number;
  selected: boolean;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  trackHeight: number;
  frameRate: number;
  snappingEnabled: boolean;
  snapCandidatesUs: readonly number[];
}

function ClipBlock({
  clip,
  track,
  asset,
  derived,
  derivedAsset,
  pixelsPerUs,
  selected,
  onCommand,
  trackHeight,
  frameRate,
  snappingEnabled,
  snapCandidatesUs,
}: ClipBlockProps) {
  const tool = useRendererStore((state) => state.tool);
  const selectClip = useRendererStore((state) => state.selectClip);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: clip.id,
    data: { kind: "clip", clipId: clip.id, trackId: track.id },
    disabled: track.locked || tool !== "select",
  });
  const [trimGesture, setTrimGesture] = useState<TrimGestureState>(IDLE_TRIM_GESTURE);
  const trimGestureRef = useRef<TrimGestureState>(IDLE_TRIM_GESTURE);
  const previewRange = trimPreviewRange(trimGesture);
  const previewClip = trimPreviewClip(trimGesture) ?? clip;
  const name = asset?.name ?? clip.assetId;
  const preparationLabel = derivedAsset ? prepStatus(derivedAsset, derived) : null;
  const isAudioComponent = clip.mediaKind === "audio";
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
      frameRate,
      snapCandidatesUs: snappingEnabled ? snapCandidatesUs : [],
      snapToleranceUs: snappingEnabled ? Math.round(8 / pixelsPerUs) : 0,
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
    if (tool !== "blade" || track.locked) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const atUs = quantizeToFrame(
      clip.timelineStartUs + Math.round(clipDurationUs(clip) * ratio),
      frameRate,
    );
    if (canSplitClipAt(clip, atUs)) void onCommand({ type: "clip.split", clipId: clip.id, atUs });
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute top-1 overflow-hidden rounded-md border text-left shadow-sm outline-none transition-[border-color,filter]",
        track.kind === "audio"
          ? "border-clip-border bg-clip-audio"
          : "border-clip-border bg-clip-video",
        selected && "border-primary ring-1 ring-primary",
        isDragging && "z-30 opacity-35",
        trimGesture.status === "trimming" && "z-30 ring-1 ring-primary",
        tool === "blade" && !track.locked && "cursor-crosshair",
      )}
      style={{
        left,
        width,
        height: Math.max(32, trackHeight - 8),
      }}
    >
      {asset?.kind === "video" && !isAudioComponent && derived && derivedAsset && (
        <TimelineFilmstrip
          asset={asset}
          clip={previewClip}
          record={derivedAsset}
          derived={derived}
          width={width}
          height={Math.max(32, trackHeight - 8)}
        />
      )}
      {asset &&
        derived &&
        derivedAsset?.waveform.state === "ready" &&
        isAudioComponent &&
        (asset.kind === "audio" || asset.hasAudio === true) && (
          <TimelineWaveform
            asset={asset}
            clip={previewClip}
            artifact={derivedAsset.waveform}
            derived={derived}
          />
        )}
      <button
        type="button"
        {...listeners}
        {...attributes}
        aria-label={`${selected ? "Selected " : ""}${name} clip`}
        className="absolute inset-0 z-20 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
        onClick={activate}
      >
        <span
          className={cn(
            "clip-texture pointer-events-none absolute inset-0",
            asset?.kind === "video" && !isAudioComponent ? "opacity-15" : "opacity-40",
          )}
        />
        <span className="relative ml-1.5 mt-1 block w-fit max-w-[75%] truncate rounded-sm bg-black/35 px-1.5 py-0.5 text-ui-xs font-medium text-white shadow-sm">
          {name}
        </span>
        <span className="relative ml-1.5 mt-0.5 block w-fit rounded-sm bg-black/25 px-1 text-ui-xs text-white/75 tabular-nums">
          {clip.id}
        </span>
        {preparationLabel && (
          <span className="absolute right-1.5 top-1 rounded bg-black/35 px-1 py-0.5 text-[9px] font-medium text-white/85">
            {preparationLabel}
          </span>
        )}
      </button>
      {tool === "trim" && !track.locked && (
        <>
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
        </>
      )}
    </div>
  );
}

function prepStatus(
  asset: DerivedAssetSnapshot,
  derived: DerivedMediaSnapshot | null,
): string | null {
  const activeJob = derived?.runtime.activeJob;
  if (activeJob?.assetId === asset.assetId) {
    const stage = activeJob.stage.replaceAll("-", " ");
    return `${stage.charAt(0).toUpperCase()}${stage.slice(1)} ${Math.round(activeJob.progress * 100)}%`;
  }
  if (asset.proxy.state === "running" || asset.proxy.state === "queued")
    return artifactStatus("Proxy", asset.proxy);
  const perception = [asset.waveform, asset.filmstrip, asset.thumbnail].find(
    (artifact) => artifact.state === "running" || artifact.state === "queued",
  );
  if (perception) return artifactStatus("Preparing", perception);
  if (asset.proxy.state === "ready") return "Proxy ready";
  if (
    asset.proxy.state === "failed" ||
    asset.thumbnail.state === "failed" ||
    asset.waveform.state === "failed" ||
    asset.filmstrip.state === "failed"
  )
    return "Prep failed";
  return null;
}

function artifactStatus(label: string, artifact: DerivedAssetSnapshot["proxy"]): string {
  return artifact.state === "running" && artifact.progress !== undefined
    ? `${label} ${Math.round(artifact.progress * 100)}%`
    : `${label} queued`;
}

function TimelineTrackRow({
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
        <ClipBlock
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
        />
      ))}
      {trackProposal && (
        <div
          className={cn(
            "pointer-events-none absolute top-1 z-40 overflow-hidden rounded-md border-2 px-2 py-1 shadow-lg",
            trackProposal.valid
              ? "border-primary bg-selection/80 text-primary"
              : "border-red-500/80 bg-red-500/15 text-red-700 dark:text-red-300",
          )}
          style={{
            left: trackProposal.timelineStartUs * pixelsPerUs,
            width: proposalWidth,
            height: Math.max(32, trackHeight - 8),
          }}
        >
          {proposalAsset?.kind === "video" &&
            !isAudioProposal &&
            derived?.assets[proposalAsset.id] && (
              <TimelineFilmstrip
                asset={proposalAsset}
                clip={{ sourceStartUs: 0, sourceEndUs: proposalAsset.durationUs }}
                record={derived.assets[proposalAsset.id]!}
                derived={derived}
                width={proposalWidth}
                height={Math.max(32, trackHeight - 8)}
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

function TrackHeader({
  track,
  index,
  total,
  height,
  onCommand,
}: {
  track: Track;
  index: number;
  total: number;
  height: number;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(track.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(track.name), [track.name]);
  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  function commitName(): void {
    setRenaming(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === track.name) {
      setName(track.name);
      return;
    }
    void onCommand({ type: "track.update", trackId: track.id, name: trimmed });
  }

  const kindLabel = track.kind === "audio" ? "A" : track.kind === "overlay" ? "O" : "V";
  return (
    <div className="grid content-center gap-0.5 border-b border-border px-2" style={{ height }}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="grid size-5 shrink-0 place-items-center rounded bg-surface text-[10px] font-semibold text-muted">
          {kindLabel}
        </span>
        {renaming ? (
          <input
            ref={renameInputRef}
            className="h-6 min-w-0 flex-1 rounded border border-border-strong bg-panel-muted px-1.5 text-ui-xs text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitName();
              if (event.key === "Escape") {
                setName(track.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-ui-xs font-medium text-secondary hover:text-primary"
            title={`${track.name} · Double-click to rename`}
            onDoubleClick={() => setRenaming(true)}
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

export function Timeline({ project, onCommand, onSeek }: TimelineProps) {
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
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const sequence = getSequence(project);
  const pixelsPerUs = (BASE_PIXELS_PER_SECOND * zoom) / 1_000_000;
  const contentDurationUs = timelineContentDurationUs(sequenceDurationUs(sequence), zoom);
  const contentWidth = Math.round(contentDurationUs * pixelsPerUs);
  const assets = useMemo(
    () => new Map(project.assets.map((asset) => [asset.id, asset])),
    [project.assets],
  );
  const selectedClip = selectedClipId
    ? sequence.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId)
    : undefined;
  const canSplitSelection = Boolean(selectedClip && canSplitClipAt(selectedClip, playheadUs));

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
          <MenuContent align="start" className="w-56 p-2">
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
            </MenuGroup>
          </MenuContent>
        </Menu>
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
      <div className="grid min-h-0 flex-1 grid-cols-[168px_1fr] overflow-hidden">
        <div
          ref={headerScrollRef}
          className="relative z-20 overflow-hidden border-r border-border bg-panel"
          onWheel={(event) => {
            if (timelineScrollRef.current) timelineScrollRef.current.scrollTop += event.deltaY;
          }}
        >
          <div className="sticky top-0 z-20 h-6 border-b border-border bg-panel" />
          {sequence.tracks.map((track, index) => (
            <TrackHeader
              key={track.id}
              track={track}
              index={index}
              total={sequence.tracks.length}
              height={trackHeight}
              onCommand={onCommand}
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

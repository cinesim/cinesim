import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pause, Play } from "lucide-react";
import {
  Scissors,
  MousePointer2,
  Trash2,
  ZoomIn,
  ZoomOut,
  Lock,
  LockOpen,
  Magnet,
  MenuIcon,
  MoveHorizontal,
  Plus,
  ChevronUp,
  ChevronDown,
  Video,
  AudioLines,
  Layers,
  Volume2,
  VolumeX,
} from "@cinesim/ui";
import {
  Button,
  cn,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  Separator,
} from "@cinesim/ui";
import { canSplitClipAt, clipDurationUs, getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Asset, Clip, EditorCommand, Project, TimelineRange, Track } from "@cinesim/core";
import type { DerivedAssetSnapshot, DerivedMediaSnapshot } from "../../../shared/api";
import type { TranscriptSnapshot } from "../../../shared/transcript";
import { projectNarrativeUnits, timelinePresentationForHeight } from "../../../shared/transcript";
import {
  IDLE_TRIM_GESTURE,
  trimPreviewClip,
  trimPreviewRange,
  transitionTrimGesture,
  type TrimGestureState,
} from "../../lib/trim-gesture";
import {
  BASE_TIMELINE_PIXELS_PER_SECOND,
  MAX_TIMELINE_ZOOM,
  timelineContentDurationUs,
  timelineFitZoom,
  timelineMajorSecondStep,
} from "../../lib/timeline-scale";
import { quantizeToFrame, timelineSnapCandidates } from "../../lib/timeline-geometry";
import { formatTimecode } from "../../lib/format";
import type { ActionResult } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorDnd } from "../workspace/editor-dnd-context";
import { TimelineFilmstrip } from "./timeline-filmstrip";
import { MasterLevelMeter } from "./master-level-meter";
import { TimelineWaveform } from "./timeline-waveform";

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

export type TimelinePaletteId = "northern-lights" | "desert-bloom" | "coastal";

const TIMELINE_PALETTES: ReadonlyArray<{
  id: TimelinePaletteId;
  name: string;
  colors: { video: string; overlay: string; audio: string; image: string };
}> = [
  {
    id: "northern-lights",
    name: "Northern Lights",
    colors: { video: "#506fa3", overlay: "#80649b", audio: "#397968", image: "#aa7a42" },
  },
  {
    id: "desert-bloom",
    name: "Desert Bloom",
    colors: { video: "#a85e58", overlay: "#895d82", audio: "#688263", image: "#b18445" },
  },
  {
    id: "coastal",
    name: "Coastal",
    colors: { video: "#397d91", overlay: "#6870a0", audio: "#438273", image: "#9b7652" },
  },
];

const FULL_TIMELINE_TRACK_CHROME_WIDTH = 168 + 72;

function timelinePaletteColor(
  paletteId: TimelinePaletteId,
  track: Track,
  asset: Asset | undefined,
): string {
  const palette = TIMELINE_PALETTES.find((candidate) => candidate.id === paletteId)!;
  if (track.kind === "audio") return palette.colors.audio;
  if (track.kind === "overlay") return palette.colors.overlay;
  return asset?.kind === "image" ? palette.colors.image : palette.colors.video;
}

export function fadeDurationFromDrag({
  edge,
  initialDurationUs,
  deltaX,
  pixelsPerUs,
  maximumDurationUs,
  frameRate,
}: {
  edge: "in" | "out";
  initialDurationUs: number;
  deltaX: number;
  pixelsPerUs: number;
  maximumDurationUs: number;
  frameRate: number;
}): number {
  const rawDurationUs = initialDurationUs + (edge === "in" ? deltaX : -deltaX) / pixelsPerUs;
  const frameDurationUs = 1_000_000 / Math.max(1, frameRate);
  const quantized = Math.round(rawDurationUs / frameDurationUs) * frameDurationUs;
  return Math.round(Math.min(maximumDurationUs, Math.max(0, quantized)));
}

interface FadeGesture {
  pointerId: number;
  edge: "in" | "out";
  startClientX: number;
  initialDurationUs: number;
  previewDurationUs: number;
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
  paletteId: TimelinePaletteId;
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
  paletteId,
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
  const [fadeGesture, setFadeGesture] = useState<FadeGesture | null>(null);
  const fadeGestureRef = useRef<FadeGesture | null>(null);
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
  const clipColor = timelinePaletteColor(paletteId, track, asset);
  const fadeInUs =
    fadeGesture?.edge === "in" ? fadeGesture.previewDurationUs : (clip.fadeInUs ?? 0);
  const fadeOutUs =
    fadeGesture?.edge === "out" ? fadeGesture.previewDurationUs : (clip.fadeOutUs ?? 0);
  const fadeInPx = Math.min(width, fadeInUs * pixelsPerUs);
  const fadeOutPx = Math.min(width, fadeOutUs * pixelsPerUs);
  const fadeCurveTop = 8;
  const fadeCurveBottom = Math.max(fadeCurveTop + 1, trackHeight - 5);
  const fadeOutStartX = width - fadeOutPx;
  const fadeInCurve = `M 0 ${fadeCurveBottom} C ${fadeInPx * 0.38} ${fadeCurveBottom}, ${fadeInPx * 0.68} ${fadeCurveTop}, ${fadeInPx} ${fadeCurveTop}`;
  const fadeOutCurve = `M ${fadeOutStartX} ${fadeCurveTop} C ${fadeOutStartX + fadeOutPx * 0.32} ${fadeCurveTop}, ${width - fadeOutPx * 0.38} ${fadeCurveBottom}, ${width} ${fadeCurveBottom}`;

  useEffect(
    () => () => {
      trimGestureRef.current = IDLE_TRIM_GESTURE;
      fadeGestureRef.current = null;
    },
    [],
  );

  function beginFade(edge: "in" | "out", event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    const gesture: FadeGesture = {
      pointerId: event.pointerId,
      edge,
      startClientX: event.clientX,
      initialDurationUs: edge === "in" ? (clip.fadeInUs ?? 0) : (clip.fadeOutUs ?? 0),
      previewDurationUs: edge === "in" ? (clip.fadeInUs ?? 0) : (clip.fadeOutUs ?? 0),
    };
    fadeGestureRef.current = gesture;
    setFadeGesture(gesture);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateFade(event: React.PointerEvent<HTMLButtonElement>): FadeGesture | null {
    const gesture = fadeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return null;
    const otherDurationUs = gesture.edge === "in" ? (clip.fadeOutUs ?? 0) : (clip.fadeInUs ?? 0);
    const next = {
      ...gesture,
      previewDurationUs: fadeDurationFromDrag({
        edge: gesture.edge,
        initialDurationUs: gesture.initialDurationUs,
        deltaX: event.clientX - gesture.startClientX,
        pixelsPerUs,
        maximumDurationUs: Math.max(0, clipDurationUs(clip) - otherDurationUs),
        frameRate,
      }),
    };
    fadeGestureRef.current = next;
    setFadeGesture(next);
    return next;
  }

  function finishFade(event: React.PointerEvent<HTMLButtonElement>) {
    const gesture = updateFade(event);
    fadeGestureRef.current = null;
    setFadeGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (gesture && gesture.previewDurationUs !== gesture.initialDurationUs)
      void onCommand({
        type: "clip.setFade",
        clipId: clip.id,
        edge: gesture.edge,
        durationUs: gesture.previewDurationUs,
      });
  }

  function cancelFade(event: React.PointerEvent<HTMLButtonElement>) {
    if (fadeGestureRef.current?.pointerId !== event.pointerId) return;
    fadeGestureRef.current = null;
    setFadeGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

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
        "group/clip absolute top-0 overflow-hidden border text-left shadow-sm outline-none transition-[border-color,filter]",
        selected && "border-primary ring-1 ring-primary",
        isDragging && "z-30 opacity-35",
        trimGesture.status === "trimming" && "z-30 ring-1 ring-primary",
        tool === "blade" && !track.locked && "cursor-crosshair",
      )}
      style={{
        left,
        width,
        height: trackHeight,
        backgroundColor: clipColor,
        borderColor: selected ? undefined : `color-mix(in srgb, ${clipColor} 72%, black)`,
      }}
    >
      {asset && asset.kind !== "audio" && !isAudioComponent && derived && derivedAsset && (
        <TimelineFilmstrip
          asset={asset}
          clip={previewClip}
          record={derivedAsset}
          derived={derived}
          width={width}
          height={trackHeight}
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
        <span className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-black/75 to-transparent" />
        <span className="pointer-events-none absolute bottom-1 left-1.5 right-1.5 z-20 truncate text-[10px] font-semibold text-white drop-shadow-sm">
          {name}
        </span>
        {preparationLabel && (
          <span className="absolute right-1.5 top-1 rounded bg-black/35 px-1 py-0.5 text-[9px] font-medium text-white/85">
            {preparationLabel}
          </span>
        )}
      </button>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[24] overflow-visible drop-shadow-sm"
        width={width}
        height={trackHeight}
        viewBox={`0 0 ${width} ${trackHeight}`}
        preserveAspectRatio="none"
      >
        {fadeInPx > 0.5 && (
          <>
            <path
              d={`M 0 0 H ${fadeInPx} V ${fadeCurveTop} C ${fadeInPx * 0.68} ${fadeCurveTop}, ${fadeInPx * 0.38} ${fadeCurveBottom}, 0 ${fadeCurveBottom} Z`}
              fill="rgba(0, 0, 0, 0.28)"
            />
            <path
              d={fadeInCurve}
              fill="none"
              stroke="rgba(255, 255, 255, 0.8)"
              strokeWidth="1.25"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        {fadeOutPx > 0.5 && (
          <>
            <path
              d={`M ${fadeOutStartX} 0 H ${width} V ${fadeCurveBottom} C ${width - fadeOutPx * 0.38} ${fadeCurveBottom}, ${fadeOutStartX + fadeOutPx * 0.32} ${fadeCurveTop}, ${fadeOutStartX} ${fadeCurveTop} Z`}
              fill="rgba(0, 0, 0, 0.28)"
            />
            <path
              d={fadeOutCurve}
              fill="none"
              stroke="rgba(255, 255, 255, 0.8)"
              strokeWidth="1.25"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      {!track.locked && (
        <>
          <button
            type="button"
            aria-label={`Adjust fade in for ${name}`}
            title={`Fade in · ${(fadeInUs / 1_000_000).toFixed(2)}s`}
            className={cn(
              "absolute top-[3px] z-[26] size-2.5 -translate-x-1/2 cursor-ew-resize rounded-[1px] border border-white/70 bg-neutral-400 shadow-[0_0_0_1px_rgba(0,0,0,0.75)] transition-[opacity,background-color] hover:bg-white hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white",
              selected || fadeInUs > 0
                ? "opacity-90"
                : "opacity-0 group-hover/clip:opacity-90 focus-visible:opacity-100",
            )}
            style={{ left: Math.min(width - 5, Math.max(5, fadeInPx)) }}
            onPointerDown={(event) => beginFade("in", event)}
            onPointerMove={updateFade}
            onPointerUp={finishFade}
            onPointerCancel={cancelFade}
            onLostPointerCapture={cancelFade}
          />
          <button
            type="button"
            aria-label={`Adjust fade out for ${name}`}
            title={`Fade out · ${(fadeOutUs / 1_000_000).toFixed(2)}s`}
            className={cn(
              "absolute top-[3px] z-[26] size-2.5 -translate-x-1/2 cursor-ew-resize rounded-[1px] border border-white/70 bg-neutral-400 shadow-[0_0_0_1px_rgba(0,0,0,0.75)] transition-[opacity,background-color] hover:bg-white hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white",
              selected || fadeOutUs > 0
                ? "opacity-90"
                : "opacity-0 group-hover/clip:opacity-90 focus-visible:opacity-100",
            )}
            style={{ left: Math.min(width - 5, Math.max(5, width - fadeOutPx)) }}
            onPointerDown={(event) => beginFade("out", event)}
            onPointerMove={updateFade}
            onPointerUp={finishFade}
            onPointerCancel={cancelFade}
            onLostPointerCapture={cancelFade}
          />
        </>
      )}
      {fadeGesture && (
        <span className="pointer-events-none absolute left-1/2 top-5 z-40 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[9px] font-semibold text-white tabular-nums">
          {(fadeGesture.previewDurationUs / 1_000_000).toFixed(2)}s
        </span>
      )}
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

function TrackHeader({
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
            className="min-w-0 flex-1 truncate text-left text-[10px] leading-4 font-medium text-secondary hover:text-primary"
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

function rangesIntersect(
  startUs: number,
  endUs: number,
  ranges: readonly TimelineRange[],
): boolean {
  return ranges.some((range) => range.startUs < endUs && range.endUs > startUs);
}

function ReducedTimeline({
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
  playheadUs: number;
  playing: boolean;
  paletteId: TimelinePaletteId;
  zoom: number;
  minimumZoom: number;
  pixelsPerUs: number;
  contentWidth: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSeek?: (timeUs: number) => void;
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
  const durationUs = Math.max(1, sequenceDurationUs(sequence));
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
    return TIMELINE_PALETTES.some((palette) => palette.id === stored)
      ? (stored as TimelinePaletteId)
      : "northern-lights";
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
            <TrackHeader
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

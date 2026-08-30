import { useEffect, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { canSplitClipAt, clipDurationUs, timeUs } from "@cinesim/core";
import type { Asset, Clip, EditorCommand, TimeUs, Track } from "@cinesim/core";
import { cn } from "@cinesim/ui";
import type { DerivedAssetSnapshot, DerivedMediaSnapshot } from "../../../shared/api";
import {
  IDLE_TRIM_GESTURE,
  trimPreviewClip,
  trimPreviewRange,
  transitionTrimGesture,
  type TrimGestureState,
} from "../../lib/trim-gesture";
import { quantizeToFrame } from "../../lib/timeline-geometry";
import type { ActionResult } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { fadeDurationFromDrag, timelinePaletteColor } from "./timeline-behavior";
import type { TimelinePaletteId } from "./timeline-behavior";
import { TimelineFilmstrip } from "./timeline-filmstrip";
import { TimelineWaveform } from "./timeline-waveform";

interface FadeGesture {
  pointerId: number;
  edge: "in" | "out";
  startClientX: number;
  initialDurationUs: TimeUs;
  previewDurationUs: TimeUs;
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
  snapCandidatesUs: readonly TimeUs[];
  paletteId: TimelinePaletteId;
}

export function TimelineClipBlock({
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
      initialDurationUs:
        edge === "in" ? (clip.fadeInUs ?? timeUs(0)) : (clip.fadeOutUs ?? timeUs(0)),
      previewDurationUs:
        edge === "in" ? (clip.fadeInUs ?? timeUs(0)) : (clip.fadeOutUs ?? timeUs(0)),
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
        maximumDurationUs: timeUs(Math.max(0, clipDurationUs(clip) - otherDurationUs)),
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
      snapToleranceUs: timeUs(snappingEnabled ? Math.round(8 / pixelsPerUs) : 0),
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
      timeUs(clip.timelineStartUs + Math.round(clipDurationUs(clip) * ratio)),
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

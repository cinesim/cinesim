import { evaluateIrFrame } from "./evaluate";
import { irTimeUs } from "./types";
import type {
  AudioPlan,
  IrClip,
  IrComposition,
  IrEditMap,
  IrProgram,
  RenderPlan,
  TimelineProjection,
} from "./types";
import { audioDuckGainAt } from "./audio-mix";

export function findIrComposition(
  program: IrProgram,
  compositionId = program.activeCompositionId,
): IrComposition {
  const composition = program.compositions.find((candidate) => candidate.id === compositionId);
  if (!composition) throw new Error(`Composition not found: ${compositionId}`);
  return composition;
}

export function projectTimeline(
  program: IrProgram,
  editMap?: IrEditMap,
  compositionId = program.activeCompositionId,
): TimelineProjection {
  const composition = findIrComposition(program, compositionId);
  const tracks = composition.timeline.tracks.map((track) => ({
    id: track.id,
    kind: track.kind,
    name: track.name,
    muted: track.muted,
    locked: track.locked,
    clips: [...track.clips]
      .sort(
        (left, right) =>
          left.timelineStartUs - right.timelineStartUs || left.id.localeCompare(right.id),
      )
      .map((clip) => {
        const structural = editMap?.nodes[clip.id]?.structural;
        return {
          id: clip.id,
          trackId: track.id,
          ...(clip.assetId === undefined ? {} : { assetId: clip.assetId }),
          label: clip.name ?? clip.assetId ?? clip.id,
          startUs: clip.timelineStartUs,
          endUs: irTimeUs(clip.timelineStartUs + clip.durationUs),
          sourceStartUs: clip.sourceStartUs,
          sourceEndUs: irTimeUs(
            clip.sourceStartUs + Math.round(clip.durationUs * clip.playbackRate),
          ),
          ...(clip.mediaKind === undefined ? {} : { mediaKind: clip.mediaKind }),
          ...(clip.linkedClipId === undefined ? {} : { linkedClipId: clip.linkedClipId }),
          enabled: clip.enabled,
          fadeInUs: clip.fades.inUs,
          fadeOutUs: clip.fades.outUs,
          audio: clip.audio,
          transform: clip.transform,
          editable: structural?.safeToMove ?? false,
          generated: structural?.kind === "generated",
        };
      }),
  }));
  const durationUs = irTimeUs(
    tracks.reduce(
      (maximum, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endUs), maximum),
      0,
    ),
  );
  return {
    compositionId: composition.id,
    name: composition.name,
    width: composition.width,
    height: composition.height,
    frameRate: composition.frameRate,
    durationUs,
    tracks,
    notes: composition.timeline.notes,
    markers: composition.timeline.markers,
    transitions: composition.timeline.transitions,
  };
}

function active(clip: IrClip, playheadUs: number): boolean {
  return (
    clip.enabled &&
    playheadUs >= clip.timelineStartUs &&
    playheadUs < clip.timelineStartUs + clip.durationUs
  );
}

function sourceTime(clip: IrClip, playheadUs: number): number {
  if (clip.freeze) return clip.sourceStartUs;
  const elapsed = Math.round((playheadUs - clip.timelineStartUs) * clip.playbackRate);
  const offset = clip.reverse ? Math.max(0, clip.durationUs - elapsed) : elapsed;
  return clip.sourceStartUs + offset;
}

function fadeGain(clip: IrClip, playheadUs: number): number {
  const elapsed = playheadUs - clip.timelineStartUs;
  const remaining = clip.durationUs - elapsed;
  const fadeIn = clip.fades.inUs > 0 ? Math.min(1, elapsed / clip.fades.inUs) : 1;
  const fadeOut = clip.fades.outUs > 0 ? Math.min(1, remaining / clip.fades.outUs) : 1;
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

export function createRenderPlan(
  program: IrProgram,
  playheadUs: number,
  compositionId = program.activeCompositionId,
): RenderPlan {
  const composition = findIrComposition(program, compositionId);
  // Track index zero is the uppermost editor track. Render plans are painter
  // ordered, so lower tracks are emitted first.
  const layers = composition.timeline.tracks.toReversed().flatMap((track) =>
    track.kind === "audio" || track.muted
      ? []
      : track.clips
          .filter((clip) => active(clip, playheadUs))
          .map((clip) => {
            const localTime = playheadUs - clip.timelineStartUs;
            return {
              clipId: clip.id,
              trackId: track.id,
              ...(clip.assetId === undefined ? {} : { assetId: clip.assetId }),
              sourceTimeUs: irTimeUs(sourceTime(clip, playheadUs)),
              opacity: clip.transform.opacity * fadeGain(clip, playheadUs),
              transform: clip.transform,
              ...(clip.content === undefined
                ? {}
                : {
                    content: evaluateIrFrame(clip.content, localTime),
                  }),
              effects: [...track.effects, ...clip.effects],
            };
          }),
  );
  return {
    compositionId,
    playheadUs: irTimeUs(playheadUs),
    background: composition.background,
    layers,
  };
}

export function createAudioPlan(
  program: IrProgram,
  playheadUs: number,
  compositionId = program.activeCompositionId,
): AudioPlan {
  const composition = findIrComposition(program, compositionId);
  const sources = composition.timeline.tracks.flatMap((track) =>
    track.kind !== "audio" || track.muted
      ? []
      : track.clips.flatMap((clip) =>
          active(clip, playheadUs) && clip.assetId !== undefined && !clip.audio.muted
            ? [
                {
                  clipId: clip.id,
                  trackId: track.id,
                  assetId: clip.assetId,
                  sourceTimeUs: irTimeUs(sourceTime(clip, playheadUs)),
                  gain:
                    Math.pow(10, clip.audio.gainDb / 20) *
                    fadeGain(clip, playheadUs) *
                    audioDuckGainAt(composition, track, clip, playheadUs),
                  pan: clip.audio.pan,
                  effects: [...track.effects, ...clip.effects],
                },
              ]
            : [],
        ),
  );
  return { compositionId, playheadUs: irTimeUs(playheadUs), sources };
}

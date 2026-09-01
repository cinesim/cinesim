import { evaluateIrFrame } from "./evaluate";
import { irTimeUs } from "./types";
import type {
  AudioPlan,
  AudioSourcePlan,
  IrClip,
  IrComposition,
  IrAudioTransition,
  IrEditMap,
  IrProgram,
  IrTrack,
  IrTransition,
  RenderPlan,
  RenderLayer,
  RenderTransition,
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
    composition.timeline.captionTracks.reduce(
      (maximum, track) =>
        track.cues.reduce(
          (cueMaximum, cue) => Math.max(cueMaximum, cue.startUs + cue.durationUs),
          maximum,
        ),
      tracks.reduce(
        (maximum, track) =>
          track.clips.reduce((inner, clip) => Math.max(inner, clip.endUs), maximum),
        0,
      ),
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
    captionTracks: composition.timeline.captionTracks,
    notes: composition.timeline.notes,
    markers: composition.timeline.markers,
    transitions: composition.timeline.transitions,
    audioTransitions: composition.timeline.audioTransitions,
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

function easingProgress(progress: number, easing: string): number {
  if (easing === "ease-in") return progress * progress;
  if (easing === "ease-out") return 1 - (1 - progress) * (1 - progress);
  if (easing === "ease-in-out")
    return progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
  return progress;
}

function renderLayer(track: IrTrack, clip: IrClip, playheadUs: number): RenderLayer {
  const localTime = Math.max(0, playheadUs - clip.timelineStartUs);
  return {
    clipId: clip.id,
    trackId: track.id,
    ...(clip.assetId === undefined ? {} : { assetId: clip.assetId }),
    sourceTimeUs: irTimeUs(sourceTime(clip, playheadUs)),
    opacity: clip.transform.opacity * fadeGain(clip, playheadUs),
    transform: { ...clip.transform },
    ...(clip.content === undefined ? {} : { content: evaluateIrFrame(clip.content, localTime) }),
    effects: [...track.effects, ...clip.effects],
  };
}

function baseRenderLayers(composition: IrComposition, playheadUs: number): RenderLayer[] {
  return composition.timeline.tracks
    .toReversed()
    .flatMap((track) =>
      track.kind === "audio" || track.muted
        ? []
        : track.clips
            .filter((clip) => active(clip, playheadUs))
            .map((clip) => renderLayer(track, clip, playheadUs)),
    );
}

interface TransitionClips {
  track: IrTrack;
  from: IrClip;
  to: IrClip;
}

function transitionClips(
  composition: IrComposition,
  transition: IrTransition,
): TransitionClips | null {
  for (const track of composition.timeline.tracks) {
    const from = track.clips.find(({ id }) => id === transition.fromClipId);
    const to = track.clips.find(({ id }) => id === transition.toClipId);
    if (from && to) return { track, from, to };
  }
  return null;
}

function activeTransition(
  transition: IrTransition,
  clips: TransitionClips,
  playheadUs: number,
): RenderTransition | null {
  const endUs = clips.to.timelineStartUs;
  const startUs = endUs - transition.durationUs;
  if (transition.durationUs === 0 || playheadUs < startUs || playheadUs >= endUs) return null;
  const rawProgress = (playheadUs - startUs) / transition.durationUs;
  return {
    id: transition.id,
    fromClipId: transition.fromClipId,
    toClipId: transition.toClipId,
    kind: transition.kind,
    startUs: irTimeUs(startUs),
    durationUs: transition.durationUs,
    progress: easingProgress(rawProgress, transition.easing),
    props: transition.props,
  };
}

function directionOffset(
  transition: RenderTransition,
  composition: IrComposition,
): { x: number; y: number } {
  const direction = transition.props.direction;
  const value = direction?.kind === "string" ? direction.value : "left";
  if (value === "right") return { x: -composition.width, y: 0 };
  if (value === "up") return { x: 0, y: composition.height };
  if (value === "down") return { x: 0, y: -composition.height };
  return { x: composition.width, y: 0 };
}

function transitionOpacity(kind: IrTransition["kind"], role: "from" | "to", progress: number) {
  if (kind === "dip")
    return role === "from" ? 1 - Math.min(1, progress * 2) : Math.max(0, progress * 2 - 1);
  if (["dissolve", "zoom", "blur"].includes(kind)) return role === "from" ? 1 - progress : progress;
  return 1;
}

function styleTransitionLayer(
  layer: RenderLayer,
  role: "from" | "to",
  transition: RenderTransition,
  composition: IrComposition,
): void {
  const progress = transition.progress;
  layer.opacity *= transitionOpacity(transition.kind, role, progress);
  if (transition.kind === "slide" || transition.kind === "push") {
    const offset = directionOffset(transition, composition);
    const amount = role === "to" ? 1 - progress : -progress;
    if (role === "to" || transition.kind === "push") {
      layer.transform.x += offset.x * amount;
      layer.transform.y += offset.y * amount;
    }
  } else if (transition.kind === "zoom") {
    const scale = role === "from" ? 1 + progress * 0.15 : 0.85 + progress * 0.15;
    layer.transform.scaleX *= scale;
    layer.transform.scaleY *= scale;
  }
  layer.transition = {
    id: transition.id,
    kind: transition.kind,
    role,
    progress,
    props: transition.props,
  };
}

function applyVisualTransition(
  layers: RenderLayer[],
  transition: RenderTransition,
  clips: TransitionClips,
  playheadUs: number,
  composition: IrComposition,
): void {
  const fromIndex = layers.findIndex(({ clipId }) => clipId === clips.from.id);
  if (fromIndex < 0) return;
  const from = layers[fromIndex]!;
  const to = renderLayer(clips.track, clips.to, clips.to.timelineStartUs);
  const prerollUs = clips.to.timelineStartUs - playheadUs;
  to.sourceTimeUs = irTimeUs(clips.to.sourceStartUs - prerollUs);
  styleTransitionLayer(from, "from", transition, composition);
  styleTransitionLayer(to, "to", transition, composition);
  layers.splice(fromIndex + 1, 0, to);
}

function renderTransitions(
  composition: IrComposition,
  layers: RenderLayer[],
  playheadUs: number,
): RenderTransition[] {
  const active: RenderTransition[] = [];
  for (const transition of composition.timeline.transitions) {
    const clips = transitionClips(composition, transition);
    if (!clips) continue;
    const planned = activeTransition(transition, clips, playheadUs);
    if (!planned) continue;
    applyVisualTransition(layers, planned, clips, playheadUs, composition);
    active.push(planned);
  }
  return active;
}

export function createRenderPlan(
  program: IrProgram,
  playheadUs: number,
  compositionId = program.activeCompositionId,
): RenderPlan {
  const composition = findIrComposition(program, compositionId);
  const layers = baseRenderLayers(composition, playheadUs);
  const transitions = renderTransitions(composition, layers, playheadUs);
  const captions = composition.timeline.captionTracks.flatMap((track) =>
    track.cues
      .filter((cue) => playheadUs >= cue.startUs && playheadUs < cue.startUs + cue.durationUs)
      .map((cue) => {
        const evaluated = evaluateIrFrame(
          {
            id: cue.id,
            kind: "cue",
            props: cue.props,
            animations: cue.animations,
            effects: [],
            children: [],
          },
          playheadUs - cue.startUs,
        );
        return {
          track,
          cue,
          localTimeUs: irTimeUs(playheadUs - cue.startUs),
          props: evaluated.props,
        };
      }),
  );
  return {
    compositionId,
    playheadUs: irTimeUs(playheadUs),
    background: composition.background,
    layers,
    transitions,
    captions,
  };
}

function plannedAudioSource(
  composition: IrComposition,
  track: IrTrack,
  clip: IrClip,
  playheadUs: number,
  timelineGainUs = playheadUs,
  sourceTimeUs = sourceTime(clip, playheadUs),
): AudioSourcePlan | null {
  if (!clip.assetId || clip.audio.muted) return null;
  return {
    clipId: clip.id,
    trackId: track.id,
    assetId: clip.assetId,
    sourceTimeUs: irTimeUs(sourceTimeUs),
    gain:
      Math.pow(10, clip.audio.gainDb / 20) *
      fadeGain(clip, timelineGainUs) *
      audioDuckGainAt(composition, track, clip, playheadUs),
    pan: clip.audio.pan,
    effects: [...track.effects, ...clip.effects],
  };
}

function baseAudioSources(composition: IrComposition, playheadUs: number): AudioSourcePlan[] {
  return composition.timeline.tracks.flatMap((track) =>
    track.kind !== "audio" || track.muted
      ? []
      : track.clips.flatMap((clip) => {
          if (!active(clip, playheadUs)) return [];
          const source = plannedAudioSource(composition, track, clip, playheadUs);
          return source ? [source] : [];
        }),
  );
}

function audioTransitionTrack(
  composition: IrComposition,
  transition: IrAudioTransition,
): { track: IrTrack; from: IrClip; to: IrClip } | null {
  for (const track of composition.timeline.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    const from = track.clips.find(({ id }) => id === transition.fromClipId);
    const to = track.clips.find(({ id }) => id === transition.toClipId);
    if (from && to) return { track, from, to };
  }
  return null;
}

function crossfadeGains(
  transition: IrAudioTransition,
  progress: number,
): { from: number; to: number } {
  return transition.curve === "equal-power"
    ? { from: Math.cos(progress * Math.PI * 0.5), to: Math.sin(progress * Math.PI * 0.5) }
    : { from: 1 - progress, to: progress };
}

function applyAudioTransition(
  composition: IrComposition,
  transition: IrAudioTransition,
  playheadUs: number,
  sources: AudioSourcePlan[],
): void {
  const clips = audioTransitionTrack(composition, transition);
  if (!clips) return;
  const startUs = clips.to.timelineStartUs - transition.durationUs;
  if (playheadUs < startUs || playheadUs >= clips.to.timelineStartUs) return;
  const progress = easingProgress(
    (playheadUs - startUs) / transition.durationUs,
    transition.easing,
  );
  const gains = crossfadeGains(transition, progress);
  const outgoing = sources.find(({ clipId }) => clipId === clips.from.id);
  if (outgoing) outgoing.gain *= gains.from;
  const incoming = plannedAudioSource(
    composition,
    clips.track,
    clips.to,
    playheadUs,
    clips.to.timelineStartUs + (playheadUs - startUs),
    clips.to.sourceStartUs - (clips.to.timelineStartUs - playheadUs),
  );
  if (incoming) {
    incoming.gain *= gains.to;
    sources.push(incoming);
  }
}

export function createAudioPlan(
  program: IrProgram,
  playheadUs: number,
  compositionId = program.activeCompositionId,
): AudioPlan {
  const composition = findIrComposition(program, compositionId);
  const sources = baseAudioSources(composition, playheadUs);
  for (const transition of composition.timeline.audioTransitions) {
    applyAudioTransition(composition, transition, playheadUs, sources);
  }
  return { compositionId, playheadUs: irTimeUs(playheadUs), sources };
}

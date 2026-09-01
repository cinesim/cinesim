import {
  irTimeUs,
  validateIrProgram,
  type EditScope,
  type IrClip,
  type IrComposition,
  type IrProgram,
  type IrSceneNode,
  type IrTrack,
  type IrValue,
  type SemanticPatch,
} from "@cinesim/ir";
import { CommandError } from "./command-types";
import { nextId } from "../ids";
import type { Asset, EditorialNote, Transform } from "../project/types";
import type { CommandContext, SemanticCommandPlan, SemanticEditorCommand } from "./command-types";

export interface ClipLocation {
  composition: IrComposition;
  track: IrTrack;
  clip: IrClip;
  index: number;
}

export interface TrackLocation {
  composition: IrComposition;
  track: IrTrack;
  index: number;
}

export function createCommandContext(
  program: IrProgram,
  assets: readonly Asset[],
  projectNotes: readonly EditorialNote[] = [],
): CommandContext {
  return {
    program: structuredClone(program),
    assets,
    assetsById: new Map(assets.map((asset) => [asset.id, asset])),
    projectNotes,
    patches: [],
  };
}

export function allIds(program: IrProgram): string[] {
  return program.compositions.flatMap((composition) => [
    composition.id,
    composition.timeline.id,
    ...composition.timeline.tracks.flatMap((track) => [
      track.id,
      ...track.clips.map((clip) => clip.id),
    ]),
    ...composition.timeline.captionTracks.flatMap((track) => [
      track.id,
      ...track.cues.flatMap((cue) => [cue.id, ...cue.words.map(({ id }) => id)]),
    ]),
    ...composition.timeline.notes.map(({ id }) => id),
    ...composition.timeline.markers.map(({ id }) => id),
    ...composition.timeline.transitions.map(({ id }) => id),
  ]);
}

export function findTrack(program: IrProgram, trackId: string): TrackLocation {
  for (const composition of program.compositions) {
    const index = composition.timeline.tracks.findIndex((track) => track.id === trackId);
    const track = composition.timeline.tracks[index];
    if (track) return { composition, track, index };
  }
  throw new CommandError("TRACK_NOT_FOUND", `Track not found: ${trackId}`);
}

export function findClip(program: IrProgram, clipId: string): ClipLocation {
  for (const composition of program.compositions) {
    for (const track of composition.timeline.tracks) {
      const index = track.clips.findIndex((clip) => clip.id === clipId);
      const clip = track.clips[index];
      if (clip) return { composition, track, clip, index };
    }
  }
  throw new CommandError("CLIP_NOT_FOUND", `Clip not found: ${clipId}`);
}

export function linkedLocation(program: IrProgram, clip: IrClip): ClipLocation | undefined {
  if (!clip.linkedClipId) return undefined;
  const linked = findClip(program, clip.linkedClipId);
  if (linked.clip.linkedClipId !== clip.id) {
    throw new CommandError("INVALID_CLIP_LINK", `Clip link is not reciprocal: ${clip.id}`);
  }
  return linked;
}

export function assertTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommandError(
      "INVALID_TIME",
      `${name} must be a non-negative safe integer number of microseconds`,
    );
  }
}

export function assertUnlocked(track: IrTrack): void {
  if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.name}`);
}

export function clipEnd(clip: IrClip): number {
  return clip.timelineStartUs + clip.durationUs;
}

export function assertNoOverlap(
  track: IrTrack,
  candidate: IrClip,
  ignoredIds = new Set<string>(),
): void {
  const overlap = track.clips.find(
    (clip) =>
      clip.id !== candidate.id &&
      !ignoredIds.has(clip.id) &&
      candidate.timelineStartUs < clipEnd(clip) &&
      clip.timelineStartUs < clipEnd(candidate),
  );
  if (overlap) {
    throw new CommandError("CLIP_OVERLAP", `${candidate.id} overlaps ${overlap.id} on ${track.id}`);
  }
}

export function assertCompatible(asset: Asset, mediaKind: "video" | "audio", track: IrTrack): void {
  const compatible =
    mediaKind === "audio"
      ? track.kind === "audio" && (asset.kind === "audio" || asset.hasAudio === true)
      : track.kind !== "audio" && asset.kind !== "audio";
  if (!compatible) {
    throw new CommandError(
      "INCOMPATIBLE_TRACK",
      `${mediaKind} from ${asset.id} is incompatible with ${track.kind} track ${track.id}`,
    );
  }
}

export function propertyPatch(
  nodeId: string,
  property: string,
  value: IrValue,
  scope: EditScope = "instance",
): SemanticPatch {
  return { type: "property.set", nodeId, property, value, scope };
}

export function timePatch(nodeId: string, property: string, value: number): SemanticPatch {
  return propertyPatch(nodeId, property, { kind: "time", valueUs: irTimeUs(value) });
}

function defaultTransform(transform: Partial<Transform> = {}): IrClip["transform"] {
  return {
    x: transform.x ?? 0,
    y: transform.y ?? 0,
    anchorX: 50,
    anchorY: 50,
    scaleX: transform.scaleX ?? 1,
    scaleY: transform.scaleY ?? 1,
    rotation: transform.rotation ?? 0,
    opacity: transform.opacity ?? 1,
    zIndex: 0,
    fit: transform.fit ?? "contain",
    cornerRadius: 0,
    blendMode: "normal",
  };
}

export function newClip(
  id: string,
  track: IrTrack,
  asset: Asset,
  mediaKind: "video" | "audio",
  timelineStartUs: number,
  sourceStartUs: number,
  durationUs: number,
  transform?: Partial<Transform>,
): IrClip {
  return {
    id,
    trackId: track.id,
    assetId: asset.id,
    mediaKind,
    timelineStartUs: irTimeUs(timelineStartUs),
    sourceStartUs: irTimeUs(sourceStartUs),
    durationUs: irTimeUs(durationUs),
    playbackRate: 1,
    enabled: true,
    reverse: false,
    freeze: false,
    loop: false,
    fades: { inUs: irTimeUs(0), outUs: irTimeUs(0) },
    transform: defaultTransform(transform),
    audio: { gainDb: 0, pan: 0, muted: false },
    effects: [],
  };
}

export function setClipRange(
  clip: IrClip,
  values: Partial<{
    start: number;
    sourceStart: number;
    duration: number;
    fadeIn: number;
    fadeOut: number;
  }>,
  patches: SemanticPatch[],
): void {
  const changes: Array<[keyof typeof values, string, number]> = [
    ["start", "start", clip.timelineStartUs],
    ["sourceStart", "in", clip.sourceStartUs],
    ["duration", "duration", clip.durationUs],
    ["fadeIn", "fadeIn", clip.fades.inUs],
    ["fadeOut", "fadeOut", clip.fades.outUs],
  ];
  for (const [key, property, current] of changes) {
    const value = values[key];
    if (value === undefined || value === current) continue;
    if (key === "start") clip.timelineStartUs = irTimeUs(value);
    else if (key === "sourceStart") clip.sourceStartUs = irTimeUs(value);
    else if (key === "duration") clip.durationUs = irTimeUs(value);
    else if (key === "fadeIn") clip.fades.inUs = irTimeUs(value);
    else clip.fades.outUs = irTimeUs(value);
    patches.push(timePatch(clip.id, property, value));
  }
}

function collectSceneAssets(node: IrSceneNode, referenced: Set<string>): void {
  const collectValues = (values: Iterable<IrValue>): void => {
    for (const value of values) if (value.kind === "resource") referenced.add(value.assetId);
  };
  collectValues(Object.values(node.props));
  for (const animation of node.animations) {
    collectValues(animation.keyframes.map((keyframe) => keyframe.value));
  }
  for (const effect of node.effects) {
    collectValues(Object.values(effect.props));
    effect.children.forEach((child) => collectSceneAssets(child, referenced));
  }
  node.children.forEach((child) => collectSceneAssets(child, referenced));
}

function referencedAssets(program: IrProgram): string[] {
  const referenced = new Set<string>();
  const clips = program.compositions.flatMap((composition) =>
    composition.timeline.tracks.flatMap((track) => track.clips),
  );
  for (const clip of clips) {
    if (clip.assetId !== undefined) referenced.add(clip.assetId);
    if (clip.content) collectSceneAssets(clip.content, referenced);
  }
  return [...referenced].sort((left, right) => left.localeCompare(right));
}

export function finishCommand(
  context: CommandContext,
  command: SemanticEditorCommand,
  summary: string,
  changedIds: string[],
  options: {
    assets?: readonly Asset[];
    createdIds?: string[];
    manifest?: SemanticCommandPlan["manifest"];
  } = {},
): SemanticCommandPlan {
  const assets = options.assets ?? context.assets;
  context.program.referencedAssetIds = referencedAssets(context.program);
  validateIrProgram(context.program, new Set(assets.map((asset) => asset.id)));
  return {
    command,
    program: context.program,
    patches: context.patches,
    manifest: options.manifest ?? {},
    summary,
    changedIds: [...new Set(changedIds)],
    createdIds: options.createdIds ?? [],
  };
}

export function allocateId(
  context: CommandContext,
  prefix: Parameters<typeof nextId>[0],
  reserved: string[] = [],
): string {
  return nextId(prefix, [...allIds(context.program), ...reserved]);
}

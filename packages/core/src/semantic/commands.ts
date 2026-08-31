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
import { nextId } from "../ids";
import { timeUs, type Asset, type TimeUs, type Transform } from "../project/types";
import { CommandError } from "../commands/types";
import type { EditorCommand, TimelineRange } from "../commands/types";

export type SemanticEditorCommand =
  | EditorCommand
  | {
      type: "property.set";
      nodeId: string;
      property: string;
      value: IrValue;
      scope?: EditScope;
    }
  | { type: "clip.slip"; clipId: string; sourceStartUs: TimeUs }
  | { type: "clip.duplicate"; clipId: string; timelineStartUs?: TimeUs; trackId?: string }
  | { type: "clip.link"; clipId: string; linkedClipId: string }
  | { type: "clip.unlink"; clipId: string };

export interface SemanticCommandPlan {
  command: SemanticEditorCommand;
  program: IrProgram;
  patches: SemanticPatch[];
  manifest: { activeCompositionId?: string };
  changedIds: string[];
  createdIds: string[];
  summary: string;
}

interface ClipLocation {
  composition: IrComposition;
  track: IrTrack;
  clip: IrClip;
  index: number;
}

interface TrackLocation {
  composition: IrComposition;
  track: IrTrack;
  index: number;
}

function clone(program: IrProgram): IrProgram {
  return structuredClone(program);
}

function allIds(program: IrProgram): string[] {
  return program.compositions.flatMap((composition) => [
    composition.id,
    composition.timeline.id,
    ...composition.timeline.tracks.flatMap((track) => [
      track.id,
      ...track.clips.map((clip) => clip.id),
    ]),
  ]);
}

function findTrack(program: IrProgram, trackId: string): TrackLocation {
  for (const composition of program.compositions) {
    const index = composition.timeline.tracks.findIndex((track) => track.id === trackId);
    const track = composition.timeline.tracks[index];
    if (track) return { composition, track, index };
  }
  throw new CommandError("TRACK_NOT_FOUND", `Track not found: ${trackId}`);
}

function findClip(program: IrProgram, clipId: string): ClipLocation {
  for (const composition of program.compositions) {
    for (const track of composition.timeline.tracks) {
      const index = track.clips.findIndex((clip) => clip.id === clipId);
      const clip = track.clips[index];
      if (clip) return { composition, track, clip, index };
    }
  }
  throw new CommandError("CLIP_NOT_FOUND", `Clip not found: ${clipId}`);
}

function linkedLocation(program: IrProgram, clip: IrClip): ClipLocation | undefined {
  if (!clip.linkedClipId) return undefined;
  const linked = findClip(program, clip.linkedClipId);
  if (linked.clip.linkedClipId !== clip.id) {
    throw new CommandError("INVALID_CLIP_LINK", `Clip link is not reciprocal: ${clip.id}`);
  }
  return linked;
}

function assertTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommandError(
      "INVALID_TIME",
      `${name} must be a non-negative safe integer number of microseconds`,
    );
  }
}

function assertUnlocked(track: IrTrack): void {
  if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.name}`);
}

function clipEnd(clip: IrClip): number {
  return clip.timelineStartUs + clip.durationUs;
}

function assertNoOverlap(track: IrTrack, candidate: IrClip, ignoredIds = new Set<string>()): void {
  for (const clip of track.clips) {
    if (clip.id === candidate.id || ignoredIds.has(clip.id)) continue;
    if (candidate.timelineStartUs < clipEnd(clip) && clip.timelineStartUs < clipEnd(candidate)) {
      throw new CommandError("CLIP_OVERLAP", `${candidate.id} overlaps ${clip.id} on ${track.id}`);
    }
  }
}

function assertCompatible(asset: Asset, mediaKind: "video" | "audio", track: IrTrack): void {
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

function propertyPatch(
  nodeId: string,
  property: string,
  value: IrValue,
  scope: EditScope = "instance",
): SemanticPatch {
  return { type: "property.set", nodeId, property, value, scope };
}

function timePatch(nodeId: string, property: string, value: number): SemanticPatch {
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
    rotation: 0,
    opacity: transform.opacity ?? 1,
    zIndex: 0,
    fit: transform.fit ?? "contain",
    cornerRadius: 0,
    blendMode: "normal",
  };
}

function newClip(
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

function referencedAssets(program: IrProgram): string[] {
  const referenced = new Set<string>();
  const collectScene = (node: IrSceneNode): void => {
    for (const value of Object.values(node.props))
      if (value.kind === "resource") referenced.add(value.assetId);
    for (const animation of node.animations)
      for (const keyframe of animation.keyframes)
        if (keyframe.value.kind === "resource") referenced.add(keyframe.value.assetId);
    for (const effect of node.effects) {
      for (const value of Object.values(effect.props))
        if (value.kind === "resource") referenced.add(value.assetId);
      effect.children.forEach(collectScene);
    }
    node.children.forEach(collectScene);
  };
  for (const composition of program.compositions) {
    for (const track of composition.timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.assetId !== undefined) referenced.add(clip.assetId);
        if (clip.content) collectScene(clip.content);
      }
    }
  }
  return [...referenced].sort((left, right) => left.localeCompare(right));
}

function finalize(
  program: IrProgram,
  assets: readonly Asset[],
  command: SemanticEditorCommand,
  patches: SemanticPatch[],
  summary: string,
  changedIds: string[],
  createdIds: string[] = [],
  manifest: SemanticCommandPlan["manifest"] = {},
): SemanticCommandPlan {
  program.referencedAssetIds = referencedAssets(program);
  validateIrProgram(program, new Set(assets.map((asset) => asset.id)));
  return {
    command,
    program,
    patches,
    manifest,
    summary,
    changedIds: [...new Set(changedIds)],
    createdIds,
  };
}

function setClipRange(
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
  if (values.start !== undefined && clip.timelineStartUs !== values.start) {
    clip.timelineStartUs = irTimeUs(values.start);
    patches.push(timePatch(clip.id, "start", values.start));
  }
  if (values.sourceStart !== undefined && clip.sourceStartUs !== values.sourceStart) {
    clip.sourceStartUs = irTimeUs(values.sourceStart);
    patches.push(timePatch(clip.id, "in", values.sourceStart));
  }
  if (values.duration !== undefined && clip.durationUs !== values.duration) {
    clip.durationUs = irTimeUs(values.duration);
    patches.push(timePatch(clip.id, "duration", values.duration));
  }
  if (values.fadeIn !== undefined && clip.fades.inUs !== values.fadeIn) {
    clip.fades.inUs = irTimeUs(values.fadeIn);
    patches.push(timePatch(clip.id, "fadeIn", values.fadeIn));
  }
  if (values.fadeOut !== undefined && clip.fades.outUs !== values.fadeOut) {
    clip.fades.outUs = irTimeUs(values.fadeOut);
    patches.push(timePatch(clip.id, "fadeOut", values.fadeOut));
  }
}

function findScene(node: IrSceneNode, id: string): IrSceneNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findScene(child, id);
    if (found) return found;
  }
  return undefined;
}

function applyGenericProperty(
  program: IrProgram,
  nodeId: string,
  property: string,
  value: IrValue,
): void {
  for (const composition of program.compositions) {
    if (composition.id === nodeId) {
      if (property === "background" && value.kind === "color") {
        composition.background = value.value;
        return;
      }
    }
    for (const track of composition.timeline.tracks) {
      if (track.id === nodeId) {
        if (property === "name" && value.kind === "string") track.name = value.value;
        else if (property === "muted" && value.kind === "boolean") track.muted = value.value;
        else if (property === "locked" && value.kind === "boolean") track.locked = value.value;
        else throw new CommandError("INVALID_PROPERTY", `Invalid ${track.id}.${property} value`);
        return;
      }
      for (const clip of track.clips) {
        if (clip.id === nodeId) {
          if (property === "enabled" && value.kind === "boolean") clip.enabled = value.value;
          else if (property === "opacity" && value.kind === "number")
            clip.transform.opacity = value.value;
          else if (property === "x" && value.kind === "length") clip.transform.x = value.value;
          else if (property === "y" && value.kind === "length") clip.transform.y = value.value;
          else if (property === "scaleX" && value.kind === "number")
            clip.transform.scaleX = value.value;
          else if (property === "scaleY" && value.kind === "number")
            clip.transform.scaleY = value.value;
          else if (property === "rotation" && value.kind === "angle")
            clip.transform.rotation = value.value;
          else if (property === "gain" && value.kind === "decibels")
            clip.audio.gainDb = value.value;
          else if (property === "pan" && value.kind === "number") clip.audio.pan = value.value;
          else if (property === "muted" && value.kind === "boolean") clip.audio.muted = value.value;
          else throw new CommandError("INVALID_PROPERTY", `Invalid ${clip.id}.${property} value`);
          return;
        }
        if (clip.content) {
          const scene = findScene(clip.content, nodeId);
          if (scene) {
            const current = scene.props[property];
            if (current !== undefined && current.kind !== value.kind) {
              throw new CommandError(
                "INVALID_PROPERTY",
                `Expected ${current.kind}, received ${value.kind}`,
              );
            }
            scene.props[property] = value;
            return;
          }
        }
      }
    }
  }
  throw new CommandError("NODE_NOT_FOUND", `Semantic node not found: ${nodeId}`);
}

function normalizeRanges(ranges: readonly TimelineRange[]): TimelineRange[] {
  if (ranges.length === 0) {
    throw new CommandError("EMPTY_RANGE_SELECTION", "Select at least one timeline range");
  }
  return ranges
    .map((range) => {
      assertTime(range.startUs, "range.startUs");
      assertTime(range.endUs, "range.endUs");
      if (range.endUs <= range.startUs) {
        throw new CommandError("INVALID_RANGE", "Timeline range must have positive duration");
      }
      return { ...range };
    })
    .sort((left, right) => left.startUs - right.startUs)
    .reduce<TimelineRange[]>((result, range) => {
      const previous = result.at(-1);
      if (!previous || range.startUs > previous.endUs) result.push(range);
      else previous.endUs = timeUs(Math.max(previous.endUs, range.endUs));
      return result;
    }, []);
}

function deletedBefore(time: number, ranges: readonly TimelineRange[]): number {
  return ranges.reduce(
    (total, range) =>
      total +
      (range.startUs >= time ? 0 : Math.max(0, Math.min(time, range.endUs) - range.startUs)),
    0,
  );
}

function planDeleteRanges(
  program: IrProgram,
  compositionId: string,
  rangesInput: readonly TimelineRange[],
  mode: "lift" | "ripple",
  patches: SemanticPatch[],
  createdIds: string[],
): string[] {
  const composition = program.compositions.find((candidate) => candidate.id === compositionId);
  if (!composition) {
    throw new CommandError("SEQUENCE_NOT_FOUND", `Composition not found: ${compositionId}`);
  }
  const ranges = normalizeRanges(rangesInput);
  const changed: string[] = [];
  const outputsByClip = new Map<string, IrClip[]>();
  const originalLinks = new Map(
    composition.timeline.tracks.flatMap((track) =>
      track.clips.map((clip) => [clip.id, clip.linkedClipId] as const),
    ),
  );
  for (const track of composition.timeline.tracks) {
    const nextClips: IrClip[] = [];
    for (const clip of track.clips) {
      const original = structuredClone(clip);
      const originalStart = clip.timelineStartUs;
      const originalEnd = clipEnd(clip);
      const segments: Array<{ start: number; end: number }> = [];
      let cursor: number = originalStart;
      for (const range of ranges) {
        if (range.endUs <= cursor) continue;
        if (range.startUs >= originalEnd) break;
        if (range.startUs > cursor) {
          segments.push({ start: cursor, end: Math.min(range.startUs, originalEnd) });
        }
        cursor = Math.max(cursor, range.endUs);
      }
      if (cursor < originalEnd) segments.push({ start: cursor, end: originalEnd });
      if (segments.length === 0) {
        assertUnlocked(track);
        patches.push({ type: "node.remove", nodeId: clip.id });
        outputsByClip.set(clip.id, []);
        changed.push(clip.id, track.id, composition.id);
        continue;
      }
      const unchanged =
        segments.length === 1 &&
        segments[0]!.start === originalStart &&
        segments[0]!.end === originalEnd &&
        (mode !== "ripple" || deletedBefore(originalStart, ranges) === 0);
      if (!unchanged) assertUnlocked(track);
      const clipOutputs: IrClip[] = [];
      const insertionPatches: SemanticPatch[] = [];
      for (const [index, segment] of segments.entries()) {
        const output = index === 0 ? clip : structuredClone(original);
        if (index > 0) {
          output.id = nextId("clip", [...allIds(program), ...createdIds]);
          createdIds.push(output.id);
        }
        const start =
          mode === "ripple" ? segment.start - deletedBefore(segment.start, ranges) : segment.start;
        const sourceStart =
          original.sourceStartUs + Math.round((segment.start - originalStart) * clip.playbackRate);
        const duration = segment.end - segment.start;
        const fadeIn =
          segment.start !== originalStart ? 0 : Math.min(original.fades.inUs, duration);
        const fadeOut =
          segment.end !== originalEnd ? 0 : Math.min(original.fades.outUs, duration - fadeIn);
        if (index === 0) {
          setClipRange(
            clip,
            {
              start,
              sourceStart,
              duration,
              fadeIn,
              fadeOut,
            },
            patches,
          );
        } else {
          output.timelineStartUs = irTimeUs(start);
          output.sourceStartUs = irTimeUs(sourceStart);
          output.durationUs = irTimeUs(duration);
          output.fades.inUs = irTimeUs(fadeIn);
          output.fades.outUs = irTimeUs(fadeOut);
          insertionPatches.push({
            type: "node.insert",
            parentId: track.id,
            node: { kind: "clip", clip: output },
            anchor: `after:${clip.id}`,
          });
        }
        nextClips.push(output);
        clipOutputs.push(output);
      }
      patches.push(...insertionPatches.reverse());
      outputsByClip.set(original.id, clipOutputs);
      if (!unchanged) changed.push(clip.id, track.id, composition.id);
    }
    track.clips = nextClips;
  }
  for (const [clipId, outputs] of outputsByClip) {
    const linkedId = originalLinks.get(clipId);
    if (!linkedId || clipId.localeCompare(linkedId) > 0) continue;
    const linkedOutputs = outputsByClip.get(linkedId);
    if (!linkedOutputs || linkedOutputs.length !== outputs.length) {
      throw new CommandError(
        "INVALID_CLIP_LINK",
        `Linked clips produced different range fragments: ${clipId}`,
      );
    }
    for (const [index, output] of outputs.entries()) {
      const linked = linkedOutputs[index]!;
      output.linkedClipId = linked.id;
      linked.linkedClipId = output.id;
    }
  }
  if (patches.length === 0) {
    throw new CommandError("EMPTY_RANGE_EDIT", "The selected timeline range contains no edit");
  }
  return changed;
}

export function planSemanticCommand(
  inputProgram: IrProgram,
  assets: readonly Asset[],
  command: SemanticEditorCommand,
): SemanticCommandPlan {
  const program = clone(inputProgram);
  const patches: SemanticPatch[] = [];
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

  if (command.type === "asset.import") {
    if (assetsById.has(command.asset.id)) {
      throw new CommandError("DUPLICATE_ID", `Asset already exists: ${command.asset.id}`);
    }
    return finalize(
      program,
      [...assets, command.asset],
      command,
      [],
      `Imported ${command.asset.name}`,
      [command.asset.id],
      [command.asset.id],
    );
  }
  if (command.type === "asset.setSource") {
    if (!assetsById.has(command.assetId)) {
      throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${command.assetId}`);
    }
    return finalize(program, assets, command, [], `Relinked ${command.assetId}`, [command.assetId]);
  }
  if (command.type === "asset.remove") {
    const selected = new Set(command.assetIds);
    const changed: string[] = [...command.assetIds];
    for (const composition of program.compositions) {
      for (const track of composition.timeline.tracks) {
        const removed = track.clips.filter(
          (clip) => clip.assetId !== undefined && selected.has(clip.assetId as Asset["id"]),
        );
        if (removed.length > 0) assertUnlocked(track);
        track.clips = track.clips.filter((clip) => !removed.includes(clip));
        for (const clip of removed) {
          patches.push({ type: "node.remove", nodeId: clip.id });
          changed.push(clip.id, track.id, composition.id);
        }
      }
    }
    return finalize(
      program,
      assets.filter((asset) => !selected.has(asset.id)),
      command,
      patches,
      `Removed ${command.assetIds.length} ${command.assetIds.length === 1 ? "asset" : "assets"}`,
      changed,
    );
  }
  if (command.type === "property.set") {
    applyGenericProperty(program, command.nodeId, command.property, command.value);
    patches.push(
      propertyPatch(command.nodeId, command.property, command.value, command.scope ?? "instance"),
    );
    return finalize(program, assets, command, patches, `Updated ${command.property}`, [
      command.nodeId,
    ]);
  }
  if (command.type === "track.add") {
    const composition = program.compositions.find(
      (candidate) => candidate.id === command.sequenceId,
    );
    if (!composition) {
      throw new CommandError("SEQUENCE_NOT_FOUND", `Composition not found: ${command.sequenceId}`);
    }
    const id = nextId("track", allIds(program));
    const count = composition.timeline.tracks.filter((track) => track.kind === command.kind).length;
    const track: IrTrack = {
      id,
      kind: command.kind,
      name:
        command.name?.trim() ||
        `${command.kind === "overlay" ? "Titles" : `${command.kind[0]!.toUpperCase()}${command.kind.slice(1)}`} ${count + 1}`,
      muted: false,
      locked: false,
      clips: [],
      effects: [],
    };
    composition.timeline.tracks.push(track);
    patches.push({
      type: "node.insert",
      parentId: composition.timeline.id,
      node: { kind: "track", track },
    });
    return finalize(
      program,
      assets,
      command,
      patches,
      `Added ${track.name}`,
      [composition.id, id],
      [id],
    );
  }
  if (command.type === "track.update") {
    const { composition, track } = findTrack(program, command.trackId);
    if (command.name !== undefined) {
      const name = command.name.trim();
      if (!name) throw new CommandError("INVALID_NAME", "Track name cannot be empty");
      track.name = name;
      patches.push(propertyPatch(track.id, "name", { kind: "string", value: name }));
    }
    if (command.muted !== undefined) {
      track.muted = command.muted;
      patches.push(propertyPatch(track.id, "muted", { kind: "boolean", value: command.muted }));
    }
    if (command.locked !== undefined) {
      track.locked = command.locked;
      patches.push(propertyPatch(track.id, "locked", { kind: "boolean", value: command.locked }));
    }
    return finalize(program, assets, command, patches, `Updated ${track.name}`, [
      composition.id,
      track.id,
    ]);
  }
  if (command.type === "track.remove") {
    const { composition, track, index } = findTrack(program, command.trackId);
    assertUnlocked(track);
    if (track.clips.length > 0) {
      throw new CommandError("TRACK_NOT_EMPTY", `Track is not empty: ${track.name}`);
    }
    composition.timeline.tracks.splice(index, 1);
    patches.push({ type: "node.remove", nodeId: track.id });
    return finalize(program, assets, command, patches, `Removed ${track.name}`, [
      composition.id,
      track.id,
    ]);
  }
  if (command.type === "track.reorder") {
    const { composition, track, index } = findTrack(program, command.trackId);
    if (command.index < 0 || command.index >= composition.timeline.tracks.length) {
      throw new CommandError("INVALID_TRACK_INDEX", `Invalid track index: ${command.index}`);
    }
    composition.timeline.tracks.splice(index, 1);
    composition.timeline.tracks.splice(command.index, 0, track);
    const next = composition.timeline.tracks[command.index + 1];
    patches.push({
      type: "node.move",
      nodeId: track.id,
      parentId: composition.timeline.id,
      ...(next === undefined ? {} : { anchor: `before:${next.id}` }),
    });
    return finalize(program, assets, command, patches, `Reordered ${track.name}`, [
      composition.id,
      track.id,
    ]);
  }
  if (command.type === "clip.add") {
    const { composition, track } = findTrack(program, command.trackId);
    assertUnlocked(track);
    const asset = assetsById.get(command.assetId);
    if (!asset) throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${command.assetId}`);
    const mediaKind = asset.kind === "audio" ? "audio" : "video";
    assertCompatible(asset, mediaKind, track);
    const sourceStart = command.sourceStartUs ?? irTimeUs(0);
    const sourceEnd = command.sourceEndUs ?? asset.durationUs;
    if (sourceEnd <= sourceStart) {
      throw new CommandError("INVALID_SOURCE_RANGE", "Clip source range must be positive");
    }
    const id = nextId("clip", allIds(program));
    const clip = newClip(
      id,
      track,
      asset,
      mediaKind,
      command.timelineStartUs,
      sourceStart,
      sourceEnd - sourceStart,
      command.transform,
    );
    assertNoOverlap(track, clip);
    track.clips.push(clip);
    patches.push({ type: "node.insert", parentId: track.id, node: { kind: "clip", clip } });
    const created = [clip.id];
    if (command.audioTrackId !== undefined) {
      const audioLocation = findTrack(program, command.audioTrackId);
      if (audioLocation.composition.id !== composition.id) {
        throw new CommandError("CROSS_COMPOSITION", "Linked clips must share a composition");
      }
      assertUnlocked(audioLocation.track);
      assertCompatible(asset, "audio", audioLocation.track);
      const audio = newClip(
        nextId("clip", [...allIds(program), clip.id]),
        audioLocation.track,
        asset,
        "audio",
        command.timelineStartUs,
        sourceStart,
        sourceEnd - sourceStart,
      );
      clip.linkedClipId = audio.id;
      audio.linkedClipId = clip.id;
      assertNoOverlap(audioLocation.track, audio);
      audioLocation.track.clips.push(audio);
      patches.push({
        type: "node.insert",
        parentId: audioLocation.track.id,
        node: { kind: "clip", clip: audio },
      });
      created.push(audio.id);
    }
    return finalize(
      program,
      assets,
      command,
      patches,
      `Added ${asset.name}`,
      [composition.id, track.id, ...created],
      created,
    );
  }
  if (command.type === "clip.remove") {
    const location = findClip(program, command.clipId);
    assertUnlocked(location.track);
    const linked = linkedLocation(program, location.clip);
    if (linked) assertUnlocked(linked.track);
    location.track.clips.splice(location.index, 1);
    patches.push({ type: "node.remove", nodeId: location.clip.id });
    const changed = [location.composition.id, location.track.id, location.clip.id];
    if (linked) {
      linked.track.clips.splice(linked.index, 1);
      patches.push({ type: "node.remove", nodeId: linked.clip.id });
      changed.push(linked.track.id, linked.clip.id);
    }
    return finalize(program, assets, command, patches, `Removed ${location.clip.id}`, changed);
  }
  if (command.type === "clip.move") {
    const location = findClip(program, command.clipId);
    assertUnlocked(location.track);
    assertTime(command.timelineStartUs, "timelineStartUs");
    const destination =
      command.trackId === undefined ? location : findTrack(program, command.trackId);
    const destinationTrack = "clip" in destination ? destination.track : destination.track;
    if (destination.composition.id !== location.composition.id) {
      throw new CommandError("CROSS_COMPOSITION", "Cannot move clips across compositions");
    }
    assertUnlocked(destinationTrack);
    const asset =
      location.clip.assetId === undefined
        ? undefined
        : assetsById.get(location.clip.assetId as Asset["id"]);
    if (asset && location.clip.mediaKind) {
      assertCompatible(asset, location.clip.mediaKind, destinationTrack);
    }
    const candidate = { ...location.clip, timelineStartUs: irTimeUs(command.timelineStartUs) };
    assertNoOverlap(destinationTrack, candidate, new Set([location.clip.id]));
    if (destinationTrack.id !== location.track.id) {
      location.track.clips.splice(location.index, 1);
      destinationTrack.clips.push(location.clip);
      location.clip.trackId = destinationTrack.id;
      patches.push({ type: "node.move", nodeId: location.clip.id, parentId: destinationTrack.id });
    }
    setClipRange(location.clip, { start: command.timelineStartUs }, patches);
    const linked = linkedLocation(program, location.clip);
    if (linked) {
      assertUnlocked(linked.track);
      const linkedCandidate = {
        ...linked.clip,
        timelineStartUs: irTimeUs(command.timelineStartUs),
      };
      assertNoOverlap(linked.track, linkedCandidate, new Set([linked.clip.id]));
      setClipRange(linked.clip, { start: command.timelineStartUs }, patches);
    }
    return finalize(program, assets, command, patches, `Moved ${location.clip.id}`, [
      location.composition.id,
      location.track.id,
      destinationTrack.id,
      location.clip.id,
      ...(linked ? [linked.track.id, linked.clip.id] : []),
    ]);
  }
  if (command.type === "clip.trimStart" || command.type === "clip.trimEnd") {
    const location = findClip(program, command.clipId);
    assertUnlocked(location.track);
    const linked = linkedLocation(program, location.clip);
    if (linked) assertUnlocked(linked.track);
    const clips = [location.clip, ...(linked ? [linked.clip] : [])];
    for (const clip of clips) {
      if (command.type === "clip.trimStart") {
        const delta = command.atUs - clip.timelineStartUs;
        const duration = clip.durationUs - delta;
        if (delta < 0 || duration <= 0) {
          throw new CommandError("INVALID_TRIM", "Trim start must remain inside the clip");
        }
        setClipRange(
          clip,
          {
            start: command.atUs,
            sourceStart: clip.sourceStartUs + Math.round(delta * clip.playbackRate),
            duration,
            fadeIn: Math.min(clip.fades.inUs, duration),
            fadeOut: Math.min(
              clip.fades.outUs,
              Math.max(0, duration - Math.min(clip.fades.inUs, duration)),
            ),
          },
          patches,
        );
      } else {
        const duration = command.atUs - clip.timelineStartUs;
        if (duration <= 0) {
          throw new CommandError("INVALID_TRIM", "Trim end must remain after the clip start");
        }
        setClipRange(
          clip,
          {
            duration,
            fadeIn: Math.min(clip.fades.inUs, duration),
            fadeOut: Math.min(
              clip.fades.outUs,
              Math.max(0, duration - Math.min(clip.fades.inUs, duration)),
            ),
          },
          patches,
        );
      }
    }
    return finalize(program, assets, command, patches, `Trimmed ${location.clip.id}`, [
      location.composition.id,
      location.track.id,
      ...clips.map((clip) => clip.id),
    ]);
  }
  if (command.type === "clip.slip") {
    const location = findClip(program, command.clipId);
    assertUnlocked(location.track);
    const asset =
      location.clip.assetId === undefined
        ? undefined
        : assetsById.get(location.clip.assetId as Asset["id"]);
    if (!asset) throw new CommandError("ASSET_NOT_FOUND", "Slip requires a media asset");
    if (
      command.sourceStartUs + location.clip.durationUs * location.clip.playbackRate >
      asset.durationUs
    ) {
      throw new CommandError("INVALID_SOURCE_RANGE", "Slip exceeds source media bounds");
    }
    const linked = linkedLocation(program, location.clip);
    for (const clip of [location.clip, ...(linked ? [linked.clip] : [])]) {
      setClipRange(clip, { sourceStart: command.sourceStartUs }, patches);
    }
    return finalize(program, assets, command, patches, `Slipped ${location.clip.id}`, [
      location.clip.id,
      ...(linked ? [linked.clip.id] : []),
    ]);
  }
  if (command.type === "clip.setFade") {
    const location = findClip(program, command.clipId);
    assertUnlocked(location.track);
    if (command.durationUs > location.clip.durationUs) {
      throw new CommandError("INVALID_FADE", "Fade cannot exceed clip duration");
    }
    const linked = linkedLocation(program, location.clip);
    for (const clip of [location.clip, ...(linked ? [linked.clip] : [])]) {
      setClipRange(
        clip,
        command.edge === "in" ? { fadeIn: command.durationUs } : { fadeOut: command.durationUs },
        patches,
      );
    }
    return finalize(program, assets, command, patches, `Updated ${command.edge} fade`, [
      location.clip.id,
      ...(linked ? [linked.clip.id] : []),
    ]);
  }
  if (command.type === "clip.split") {
    const location = findClip(program, command.clipId);
    assertUnlocked(location.track);
    const linked = linkedLocation(program, location.clip);
    if (linked) assertUnlocked(linked.track);
    const splitOne = (item: ClipLocation, allocated: string[]): IrClip => {
      const offset = command.atUs - item.clip.timelineStartUs;
      if (offset <= 0 || offset >= item.clip.durationUs) {
        throw new CommandError("INVALID_SPLIT", "Split point must be inside the clip");
      }
      const right = structuredClone(item.clip);
      right.id = nextId("clip", [...allIds(program), ...allocated]);
      right.timelineStartUs = irTimeUs(command.atUs);
      right.sourceStartUs = irTimeUs(
        item.clip.sourceStartUs + Math.round(offset * item.clip.playbackRate),
      );
      right.durationUs = irTimeUs(item.clip.durationUs - offset);
      right.fades.inUs = irTimeUs(0);
      item.clip.durationUs = irTimeUs(offset);
      item.clip.fades.outUs = irTimeUs(0);
      item.track.clips.splice(item.index + 1, 0, right);
      patches.push(
        timePatch(item.clip.id, "duration", item.clip.durationUs),
        timePatch(item.clip.id, "fadeOut", 0),
        {
          type: "node.insert",
          parentId: item.track.id,
          node: { kind: "clip", clip: right },
          anchor: `after:${item.clip.id}`,
        },
      );
      return right;
    };
    const right = splitOne(location, []);
    const created = [right.id];
    if (linked) {
      const linkedRight = splitOne(linked, created);
      right.linkedClipId = linkedRight.id;
      linkedRight.linkedClipId = right.id;
      created.push(linkedRight.id);
    }
    return finalize(
      program,
      assets,
      command,
      patches,
      `Split ${location.clip.id}`,
      [location.composition.id, location.track.id, location.clip.id, ...created],
      created,
    );
  }
  if (command.type === "clip.duplicate") {
    const location = findClip(program, command.clipId);
    assertUnlocked(location.track);
    const destination = command.trackId ? findTrack(program, command.trackId) : location;
    const track = destination.track;
    const duplicate = structuredClone(location.clip);
    duplicate.id = nextId("clip", allIds(program));
    duplicate.trackId = track.id;
    duplicate.timelineStartUs = irTimeUs(command.timelineStartUs ?? clipEnd(location.clip));
    delete duplicate.linkedClipId;
    assertNoOverlap(track, duplicate);
    track.clips.push(duplicate);
    patches.push({
      type: "node.insert",
      parentId: track.id,
      node: { kind: "clip", clip: duplicate },
      anchor: `after:${location.clip.id}`,
    });
    return finalize(
      program,
      assets,
      command,
      patches,
      `Duplicated ${location.clip.id}`,
      [track.id, duplicate.id],
      [duplicate.id],
    );
  }
  if (command.type === "clip.link") {
    const left = findClip(program, command.clipId);
    const right = findClip(program, command.linkedClipId);
    if (
      left.clip.id === right.clip.id ||
      left.clip.assetId !== right.clip.assetId ||
      left.clip.timelineStartUs !== right.clip.timelineStartUs ||
      left.clip.sourceStartUs !== right.clip.sourceStartUs ||
      left.clip.durationUs !== right.clip.durationUs
    ) {
      throw new CommandError("INVALID_CLIP_LINK", "Linked clips must share asset and edit range");
    }
    left.clip.linkedClipId = right.clip.id;
    right.clip.linkedClipId = left.clip.id;
    patches.push(
      propertyPatch(left.clip.id, "linked", { kind: "string", value: right.clip.id }),
      propertyPatch(right.clip.id, "linked", { kind: "string", value: left.clip.id }),
    );
    return finalize(
      program,
      assets,
      command,
      patches,
      `Linked ${left.clip.id} and ${right.clip.id}`,
      [left.clip.id, right.clip.id],
    );
  }
  if (command.type === "clip.unlink") {
    const left = findClip(program, command.clipId);
    const right = linkedLocation(program, left.clip);
    if (!right) throw new CommandError("INVALID_CLIP_LINK", `${left.clip.id} is not linked`);
    delete left.clip.linkedClipId;
    delete right.clip.linkedClipId;
    patches.push(
      { type: "property.remove", nodeId: left.clip.id, property: "linked" },
      { type: "property.remove", nodeId: right.clip.id, property: "linked" },
    );
    return finalize(program, assets, command, patches, `Unlinked ${left.clip.id}`, [
      left.clip.id,
      right.clip.id,
    ]);
  }
  if (command.type === "sequence.deleteRanges") {
    const created: string[] = [];
    const changed = planDeleteRanges(
      program,
      command.sequenceId,
      command.ranges,
      command.mode,
      patches,
      created,
    );
    return finalize(
      program,
      assets,
      command,
      patches,
      `${command.mode === "ripple" ? "Ripple" : "Lift"} deleted selected ranges`,
      changed,
      created,
    );
  }
  if (command.type === "sequence.remove") {
    const index = program.compositions.findIndex(
      (composition) => composition.id === command.sequenceId,
    );
    const composition = program.compositions[index];
    if (!composition)
      throw new CommandError("SEQUENCE_NOT_FOUND", `Composition not found: ${command.sequenceId}`);
    if (program.compositions.length === 1) {
      throw new CommandError("LAST_SEQUENCE", "A project must contain at least one composition");
    }
    const locked = composition.timeline.tracks.find((track) => track.locked);
    if (locked) throw new CommandError("TRACK_LOCKED", `Unlock ${locked.name} first`);
    program.compositions.splice(index, 1);
    patches.push({ type: "node.remove", nodeId: composition.id });
    const nextActive =
      program.activeCompositionId === composition.id
        ? [...program.compositions].sort((left, right) => left.id.localeCompare(right.id))[0]!.id
        : program.activeCompositionId;
    program.activeCompositionId = nextActive;
    return finalize(
      program,
      assets,
      command,
      patches,
      `Removed ${composition.name}`,
      [composition.id],
      [],
      { activeCompositionId: nextActive },
    );
  }
  if (command.type === "sequence.createFromAssets") {
    const selected = command.assetIds.map((id) => {
      const asset = assetsById.get(id);
      if (!asset) throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${id}`);
      return asset;
    });
    const template = program.compositions.find(
      (composition) => composition.id === program.activeCompositionId,
    )!;
    const sequenceId = nextId("sequence", allIds(program));
    const videoTrack: IrTrack = {
      id: nextId("track", allIds(program)),
      kind: "video",
      name: "Video 1",
      muted: false,
      locked: false,
      clips: [],
      effects: [],
    };
    const audioTrack: IrTrack = {
      id: nextId("track", [...allIds(program), videoTrack.id]),
      kind: "audio",
      name: "Audio 1",
      muted: false,
      locked: false,
      clips: [],
      effects: [],
    };
    const created = [sequenceId, videoTrack.id, audioTrack.id];
    let start = 0;
    for (const asset of selected) {
      const primaryTrack = asset.kind === "audio" ? audioTrack : videoTrack;
      const primary = newClip(
        nextId("clip", [...allIds(program), ...created]),
        primaryTrack,
        asset,
        asset.kind === "audio" ? "audio" : "video",
        start,
        0,
        asset.durationUs,
      );
      primaryTrack.clips.push(primary);
      created.push(primary.id);
      if (asset.kind === "video" && asset.hasAudio) {
        const audio = newClip(
          nextId("clip", [...allIds(program), ...created]),
          audioTrack,
          asset,
          "audio",
          start,
          0,
          asset.durationUs,
        );
        primary.linkedClipId = audio.id;
        audio.linkedClipId = primary.id;
        audioTrack.clips.push(audio);
        created.push(audio.id);
      }
      start += asset.durationUs;
    }
    const composition: IrComposition = {
      id: sequenceId,
      name: command.name?.trim() || `Timeline ${program.compositions.length + 1}`,
      width: command.width ?? template.width,
      height: command.height ?? template.height,
      frameRate: command.frameRate ?? template.frameRate,
      background: template.background,
      timeline: {
        id: `timeline_${sequenceId.replace(/^sequence_/u, "")}`,
        tracks: [videoTrack, audioTrack],
        markers: [],
        transitions: [],
      },
    };
    program.compositions.push(composition);
    program.activeCompositionId = composition.id;
    patches.push({
      type: "node.insert",
      parentId: "$program",
      node: { kind: "composition", composition },
    });
    return finalize(
      program,
      assets,
      command,
      patches,
      `Created ${composition.name}`,
      created,
      created,
      { activeCompositionId: composition.id },
    );
  }
  throw new CommandError(
    "UNSUPPORTED_COMMAND",
    `Unsupported semantic command: ${(command as { type: string }).type}`,
  );
}

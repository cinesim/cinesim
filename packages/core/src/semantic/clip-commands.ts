import { irTimeUs, type IrClip } from "@cinesim/ir";
import { CommandError } from "../commands/types";
import type { Asset } from "../project/types";
import {
  allocateId,
  assertCompatible,
  assertNoOverlap,
  assertTime,
  assertUnlocked,
  clipEnd,
  findClip,
  findTrack,
  finishCommand,
  linkedLocation,
  newClip,
  propertyPatch,
  setClipRange,
  timePatch,
  type ClipLocation,
} from "./command-helpers";
import type { ClipCommand, CommandContext, SemanticCommandPlan } from "./command-types";

function addLinkedAudio(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.add" }>,
  video: IrClip,
  asset: Asset,
  sourceStart: number,
  duration: number,
): IrClip | undefined {
  if (command.audioTrackId === undefined) return undefined;
  const audioLocation = findTrack(context.program, command.audioTrackId);
  const videoLocation = findTrack(context.program, command.trackId);
  if (audioLocation.composition.id !== videoLocation.composition.id) {
    throw new CommandError("CROSS_COMPOSITION", "Linked clips must share a composition");
  }
  assertUnlocked(audioLocation.track);
  assertCompatible(asset, "audio", audioLocation.track);
  const audio = newClip(
    allocateId(context, "clip", [video.id]),
    audioLocation.track,
    asset,
    "audio",
    command.timelineStartUs,
    sourceStart,
    duration,
  );
  video.linkedClipId = audio.id;
  audio.linkedClipId = video.id;
  assertNoOverlap(audioLocation.track, audio);
  audioLocation.track.clips.push(audio);
  context.patches.push({
    type: "node.insert",
    parentId: audioLocation.track.id,
    node: { kind: "clip", clip: audio },
  });
  return audio;
}

function addClip(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.add" }>,
): SemanticCommandPlan {
  const { composition, track } = findTrack(context.program, command.trackId);
  assertUnlocked(track);
  const asset = context.assetsById.get(command.assetId);
  if (!asset) throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${command.assetId}`);
  const mediaKind = asset.kind === "audio" ? "audio" : "video";
  assertCompatible(asset, mediaKind, track);
  const sourceStart = command.sourceStartUs ?? irTimeUs(0);
  const sourceEnd = command.sourceEndUs ?? asset.durationUs;
  if (sourceEnd <= sourceStart) {
    throw new CommandError("INVALID_SOURCE_RANGE", "Clip source range must be positive");
  }
  const clip = newClip(
    allocateId(context, "clip"),
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
  context.patches.push({ type: "node.insert", parentId: track.id, node: { kind: "clip", clip } });
  const audio = addLinkedAudio(context, command, clip, asset, sourceStart, sourceEnd - sourceStart);
  const createdIds = [clip.id, ...(audio ? [audio.id] : [])];
  return finishCommand(
    context,
    command,
    `Added ${asset.name}`,
    [composition.id, track.id, ...createdIds],
    { createdIds },
  );
}

function removeClip(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.remove" }>,
): SemanticCommandPlan {
  const location = findClip(context.program, command.clipId);
  assertUnlocked(location.track);
  const linked = linkedLocation(context.program, location.clip);
  if (linked) assertUnlocked(linked.track);
  location.track.clips.splice(location.index, 1);
  context.patches.push({ type: "node.remove", nodeId: location.clip.id });
  const changed = [location.composition.id, location.track.id, location.clip.id];
  if (linked) {
    linked.track.clips.splice(linked.index, 1);
    context.patches.push({ type: "node.remove", nodeId: linked.clip.id });
    changed.push(linked.track.id, linked.clip.id);
  }
  return finishCommand(context, command, `Removed ${location.clip.id}`, changed);
}

function assertMoveCompatible(
  context: CommandContext,
  location: ClipLocation,
  destination: ClipLocation | ReturnType<typeof findTrack>,
): void {
  if (destination.composition.id !== location.composition.id) {
    throw new CommandError("CROSS_COMPOSITION", "Cannot move clips across compositions");
  }
  assertUnlocked(destination.track);
  const asset =
    location.clip.assetId === undefined
      ? undefined
      : context.assetsById.get(location.clip.assetId as Asset["id"]);
  if (asset && location.clip.mediaKind) {
    assertCompatible(asset, location.clip.mediaKind, destination.track);
  }
}

function moveClip(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.move" }>,
): SemanticCommandPlan {
  const location = findClip(context.program, command.clipId);
  assertUnlocked(location.track);
  assertTime(command.timelineStartUs, "timelineStartUs");
  const destination =
    command.trackId === undefined ? location : findTrack(context.program, command.trackId);
  assertMoveCompatible(context, location, destination);
  const candidate = { ...location.clip, timelineStartUs: irTimeUs(command.timelineStartUs) };
  assertNoOverlap(destination.track, candidate, new Set([location.clip.id]));
  if (destination.track.id !== location.track.id) {
    location.track.clips.splice(location.index, 1);
    destination.track.clips.push(location.clip);
    location.clip.trackId = destination.track.id;
    context.patches.push({
      type: "node.move",
      nodeId: location.clip.id,
      parentId: destination.track.id,
    });
  }
  setClipRange(location.clip, { start: command.timelineStartUs }, context.patches);
  const linked = linkedLocation(context.program, location.clip);
  if (linked) {
    assertUnlocked(linked.track);
    assertNoOverlap(
      linked.track,
      { ...linked.clip, timelineStartUs: irTimeUs(command.timelineStartUs) },
      new Set([linked.clip.id]),
    );
    setClipRange(linked.clip, { start: command.timelineStartUs }, context.patches);
  }
  return finishCommand(context, command, `Moved ${location.clip.id}`, [
    location.composition.id,
    location.track.id,
    destination.track.id,
    location.clip.id,
    ...(linked ? [linked.track.id, linked.clip.id] : []),
  ]);
}

function trimStart(clip: IrClip, atUs: number, context: CommandContext): void {
  const delta = atUs - clip.timelineStartUs;
  const duration = clip.durationUs - delta;
  if (delta < 0 || duration <= 0) {
    throw new CommandError("INVALID_TRIM", "Trim start must remain inside the clip");
  }
  const fadeIn = Math.min(clip.fades.inUs, duration);
  setClipRange(
    clip,
    {
      start: atUs,
      sourceStart: clip.sourceStartUs + Math.round(delta * clip.playbackRate),
      duration,
      fadeIn,
      fadeOut: Math.min(clip.fades.outUs, Math.max(0, duration - fadeIn)),
    },
    context.patches,
  );
}

function trimEnd(clip: IrClip, atUs: number, context: CommandContext): void {
  const duration = atUs - clip.timelineStartUs;
  if (duration <= 0) {
    throw new CommandError("INVALID_TRIM", "Trim end must remain after the clip start");
  }
  const fadeIn = Math.min(clip.fades.inUs, duration);
  setClipRange(
    clip,
    {
      duration,
      fadeIn,
      fadeOut: Math.min(clip.fades.outUs, Math.max(0, duration - fadeIn)),
    },
    context.patches,
  );
}

function trimClip(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.trimStart" | "clip.trimEnd" }>,
): SemanticCommandPlan {
  const location = findClip(context.program, command.clipId);
  assertUnlocked(location.track);
  const linked = linkedLocation(context.program, location.clip);
  if (linked) assertUnlocked(linked.track);
  const clips = [location.clip, ...(linked ? [linked.clip] : [])];
  const trim = command.type === "clip.trimStart" ? trimStart : trimEnd;
  clips.forEach((clip) => trim(clip, command.atUs, context));
  return finishCommand(context, command, `Trimmed ${location.clip.id}`, [
    location.composition.id,
    location.track.id,
    ...clips.map((clip) => clip.id),
  ]);
}

function slipClip(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.slip" }>,
): SemanticCommandPlan {
  const location = findClip(context.program, command.clipId);
  assertUnlocked(location.track);
  const asset =
    location.clip.assetId === undefined
      ? undefined
      : context.assetsById.get(location.clip.assetId as Asset["id"]);
  if (!asset) throw new CommandError("ASSET_NOT_FOUND", "Slip requires a media asset");
  if (
    command.sourceStartUs + location.clip.durationUs * location.clip.playbackRate >
    asset.durationUs
  ) {
    throw new CommandError("INVALID_SOURCE_RANGE", "Slip exceeds source media bounds");
  }
  const linked = linkedLocation(context.program, location.clip);
  const clips = [location.clip, ...(linked ? [linked.clip] : [])];
  clips.forEach((clip) =>
    setClipRange(clip, { sourceStart: command.sourceStartUs }, context.patches),
  );
  return finishCommand(
    context,
    command,
    `Slipped ${location.clip.id}`,
    clips.map((clip) => clip.id),
  );
}

function setFade(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.setFade" }>,
): SemanticCommandPlan {
  const location = findClip(context.program, command.clipId);
  assertUnlocked(location.track);
  if (command.durationUs > location.clip.durationUs) {
    throw new CommandError("INVALID_FADE", "Fade cannot exceed clip duration");
  }
  const linked = linkedLocation(context.program, location.clip);
  const clips = [location.clip, ...(linked ? [linked.clip] : [])];
  clips.forEach((clip) =>
    setClipRange(
      clip,
      command.edge === "in" ? { fadeIn: command.durationUs } : { fadeOut: command.durationUs },
      context.patches,
    ),
  );
  return finishCommand(
    context,
    command,
    `Updated ${command.edge} fade`,
    clips.map((clip) => clip.id),
  );
}

function splitOne(
  context: CommandContext,
  item: ClipLocation,
  atUs: number,
  reservedIds: string[],
): IrClip {
  const offset = atUs - item.clip.timelineStartUs;
  if (offset <= 0 || offset >= item.clip.durationUs) {
    throw new CommandError("INVALID_SPLIT", "Split point must be inside the clip");
  }
  const right = structuredClone(item.clip);
  right.id = allocateId(context, "clip", reservedIds);
  right.timelineStartUs = irTimeUs(atUs);
  right.sourceStartUs = irTimeUs(
    item.clip.sourceStartUs + Math.round(offset * item.clip.playbackRate),
  );
  right.durationUs = irTimeUs(item.clip.durationUs - offset);
  right.fades.inUs = irTimeUs(0);
  item.clip.durationUs = irTimeUs(offset);
  item.clip.fades.outUs = irTimeUs(0);
  item.track.clips.splice(item.index + 1, 0, right);
  context.patches.push(
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
}

function splitClip(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.split" }>,
): SemanticCommandPlan {
  const location = findClip(context.program, command.clipId);
  assertUnlocked(location.track);
  const linked = linkedLocation(context.program, location.clip);
  if (linked) assertUnlocked(linked.track);
  const right = splitOne(context, location, command.atUs, []);
  const createdIds = [right.id];
  if (linked) {
    const linkedRight = splitOne(context, linked, command.atUs, createdIds);
    right.linkedClipId = linkedRight.id;
    linkedRight.linkedClipId = right.id;
    createdIds.push(linkedRight.id);
  }
  return finishCommand(
    context,
    command,
    `Split ${location.clip.id}`,
    [location.composition.id, location.track.id, location.clip.id, ...createdIds],
    { createdIds },
  );
}

function duplicateClip(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.duplicate" }>,
): SemanticCommandPlan {
  const location = findClip(context.program, command.clipId);
  assertUnlocked(location.track);
  const destination = command.trackId ? findTrack(context.program, command.trackId) : location;
  const duplicate = structuredClone(location.clip);
  duplicate.id = allocateId(context, "clip");
  duplicate.trackId = destination.track.id;
  duplicate.timelineStartUs = irTimeUs(command.timelineStartUs ?? clipEnd(location.clip));
  delete duplicate.linkedClipId;
  assertNoOverlap(destination.track, duplicate);
  destination.track.clips.push(duplicate);
  context.patches.push({
    type: "node.insert",
    parentId: destination.track.id,
    node: { kind: "clip", clip: duplicate },
    anchor: `after:${location.clip.id}`,
  });
  return finishCommand(
    context,
    command,
    `Duplicated ${location.clip.id}`,
    [destination.track.id, duplicate.id],
    { createdIds: [duplicate.id] },
  );
}

function linkClips(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.link" }>,
): SemanticCommandPlan {
  const left = findClip(context.program, command.clipId);
  const right = findClip(context.program, command.linkedClipId);
  const sameRange =
    left.clip.assetId === right.clip.assetId &&
    left.clip.timelineStartUs === right.clip.timelineStartUs &&
    left.clip.sourceStartUs === right.clip.sourceStartUs &&
    left.clip.durationUs === right.clip.durationUs;
  if (left.clip.id === right.clip.id || !sameRange) {
    throw new CommandError("INVALID_CLIP_LINK", "Linked clips must share asset and edit range");
  }
  left.clip.linkedClipId = right.clip.id;
  right.clip.linkedClipId = left.clip.id;
  context.patches.push(
    propertyPatch(left.clip.id, "linked", { kind: "string", value: right.clip.id }),
    propertyPatch(right.clip.id, "linked", { kind: "string", value: left.clip.id }),
  );
  return finishCommand(context, command, `Linked ${left.clip.id} and ${right.clip.id}`, [
    left.clip.id,
    right.clip.id,
  ]);
}

function unlinkClip(
  context: CommandContext,
  command: Extract<ClipCommand, { type: "clip.unlink" }>,
): SemanticCommandPlan {
  const left = findClip(context.program, command.clipId);
  const right = linkedLocation(context.program, left.clip);
  if (!right) throw new CommandError("INVALID_CLIP_LINK", `${left.clip.id} is not linked`);
  delete left.clip.linkedClipId;
  delete right.clip.linkedClipId;
  context.patches.push(
    { type: "property.remove", nodeId: left.clip.id, property: "linked" },
    { type: "property.remove", nodeId: right.clip.id, property: "linked" },
  );
  return finishCommand(context, command, `Unlinked ${left.clip.id}`, [left.clip.id, right.clip.id]);
}

export function planClipCommand(
  context: CommandContext,
  command: ClipCommand,
): SemanticCommandPlan {
  switch (command.type) {
    case "clip.add":
      return addClip(context, command);
    case "clip.remove":
      return removeClip(context, command);
    case "clip.move":
      return moveClip(context, command);
    case "clip.trimStart":
    case "clip.trimEnd":
      return trimClip(context, command);
    case "clip.slip":
      return slipClip(context, command);
    case "clip.setFade":
      return setFade(context, command);
    case "clip.split":
      return splitClip(context, command);
    case "clip.duplicate":
      return duplicateClip(context, command);
    case "clip.link":
      return linkClips(context, command);
    case "clip.unlink":
      return unlinkClip(context, command);
  }
}

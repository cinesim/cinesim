import { irTimeUs, type IrAnimation, type IrEffect, type IrSceneNode } from "@cinesim/ir";
import type { CommandContext, KeyframeCommand, SemanticCommandPlan } from "./command-types";
import { CommandError } from "./command-types";
import { finishCommand } from "./command-helpers";
import type { IrClip, IrComposition, IrTrack } from "@cinesim/ir";

function namedAnimation(
  animations: readonly IrAnimation[] | undefined,
  property: string,
): IrAnimation | undefined {
  return animations?.find((animation) => animation.property === property);
}

function effectAnimation(
  effects: readonly IrEffect[],
  nodeId: string,
  property: string,
): IrAnimation | undefined {
  const effect = effects.find((candidate) => candidate.id === nodeId);
  return namedAnimation(effect?.animations, property);
}

function clipAnimation(clip: IrClip, nodeId: string, property: string): IrAnimation | undefined {
  if (clip.id === nodeId) return namedAnimation(clip.animations, property);
  const effect = effectAnimation(clip.effects, nodeId, property);
  if (effect || !clip.content) return effect;
  return sceneAnimation(clip.content, nodeId, property);
}

function adjustmentAnimation(
  adjustment: NonNullable<IrTrack["adjustments"]>[number],
  nodeId: string,
  property: string,
): IrAnimation | undefined {
  return adjustment.id === nodeId
    ? namedAnimation(adjustment.animations, property)
    : effectAnimation(adjustment.effects, nodeId, property);
}

function trackAnimation(track: IrTrack, nodeId: string, property: string): IrAnimation | undefined {
  const ownEffect = effectAnimation(track.effects, nodeId, property);
  if (ownEffect) return ownEffect;
  for (const adjustment of track.adjustments ?? []) {
    const animation = adjustmentAnimation(adjustment, nodeId, property);
    if (animation) return animation;
  }
  for (const clip of track.clips) {
    const animation = clipAnimation(clip, nodeId, property);
    if (animation) return animation;
  }
  return undefined;
}

function compositionAnimation(
  composition: IrComposition,
  nodeId: string,
  property: string,
): IrAnimation | undefined {
  for (const track of composition.timeline.tracks) {
    const animation = trackAnimation(track, nodeId, property);
    if (animation) return animation;
  }
  const cue = composition.timeline.captionTracks
    .flatMap((track) => track.cues)
    .find((candidate) => candidate.id === nodeId);
  return namedAnimation(cue?.animations, property);
}

function sceneAnimation(
  node: IrSceneNode,
  nodeId: string,
  property: string,
): IrAnimation | undefined {
  if (node.id === nodeId)
    return node.animations.find((animation) => animation.property === property);
  const effect = effectAnimation(node.effects, nodeId, property);
  if (effect) return effect;
  for (const child of node.children) {
    const animation = sceneAnimation(child, nodeId, property);
    if (animation) return animation;
  }
  return undefined;
}

function findAnimation(
  context: CommandContext,
  nodeId: string,
  property: string,
): IrAnimation | undefined {
  for (const composition of context.program.compositions) {
    const animation = compositionAnimation(composition, nodeId, property);
    if (animation) return animation;
  }
  return undefined;
}

export function planKeyframeCommand(
  context: CommandContext,
  command: KeyframeCommand,
): SemanticCommandPlan {
  const animation = findAnimation(context, command.nodeId, command.property);
  if (!animation) throw new CommandError("KEYFRAME_NOT_FOUND", "Keyframe binding was not found.");
  if (command.type === "keyframe.add") return addKeyframe(context, command, animation);
  if (command.type === "keyframe.remove") return removeKeyframe(context, command, animation);
  return setKeyframe(context, command, animation);
}

const EASINGS = new Set(["linear", "hold", "ease-in", "ease-out", "ease-in-out"]);

function validEasing(easing: string | undefined): string | undefined {
  if (easing !== undefined && !EASINGS.has(easing))
    throw new CommandError("KEYFRAME_EASING", `Unsupported keyframe easing: ${easing}.`);
  return easing;
}

function assertUniqueTime(animation: IrAnimation, at: number, excludedIndex = -1): void {
  if (animation.keyframes.some((keyframe, index) => index !== excludedIndex && keyframe.at === at))
    throw new CommandError("KEYFRAME_TIME", "Keyframes in one animation must use unique times.");
}

function setKeyframe(
  context: CommandContext,
  command: Extract<KeyframeCommand, { type: "keyframe.set" }>,
  animation: IrAnimation,
): SemanticCommandPlan {
  const keyframe = setKeyframeTarget(command, animation);
  const atUs = command.atUs === undefined ? undefined : irTimeUs(command.atUs);
  if (atUs !== undefined) assertUniqueTime(animation, atUs, command.index);
  const easing = validEasing(command.easing);
  context.patches.push(setKeyframePatch(command, atUs, easing));
  applyKeyframeChange(keyframe, command.value, atUs, easing);
  animation.keyframes.sort((left, right) => left.at - right.at);
  return finishCommand(context, command, `Updated ${command.property} keyframe.`, [command.nodeId]);
}

function setKeyframeTarget(
  command: Extract<KeyframeCommand, { type: "keyframe.set" }>,
  animation: IrAnimation,
): IrAnimation["keyframes"][number] {
  if (command.atUs === undefined && command.value === undefined && command.easing === undefined)
    throw new CommandError("KEYFRAME_EMPTY", "Keyframe edit must change time, value, or easing.");
  const keyframe = animation.keyframes[command.index];
  if (!keyframe) throw new CommandError("KEYFRAME_NOT_FOUND", "Keyframe binding was not found.");
  if (command.value && command.value.kind !== keyframe.value.kind)
    throw new CommandError("KEYFRAME_TYPE", "Keyframe value type cannot change.");
  return keyframe;
}

function setKeyframePatch(
  command: Extract<KeyframeCommand, { type: "keyframe.set" }>,
  atUs: ReturnType<typeof irTimeUs> | undefined,
  easing: string | undefined,
): Extract<import("@cinesim/ir").SemanticPatch, { type: "keyframe.set" }> {
  return {
    type: "keyframe.set",
    nodeId: command.nodeId,
    property: command.property,
    index: command.index,
    ...(atUs === undefined ? {} : { atUs }),
    ...(command.value === undefined ? {} : { value: command.value }),
    ...(easing === undefined ? {} : { easing }),
  };
}

function applyKeyframeChange(
  keyframe: IrAnimation["keyframes"][number],
  value: import("@cinesim/ir").IrValue | undefined,
  atUs: ReturnType<typeof irTimeUs> | undefined,
  easing: string | undefined,
): void {
  if (atUs !== undefined) keyframe.at = atUs;
  if (value !== undefined) keyframe.value = value;
  if (easing !== undefined) keyframe.easing = easing;
}

function addKeyframe(
  context: CommandContext,
  command: Extract<KeyframeCommand, { type: "keyframe.add" }>,
  animation: IrAnimation,
): SemanticCommandPlan {
  const reference = animation.keyframes[0];
  if (!reference || reference.value.kind !== command.value.kind)
    throw new CommandError("KEYFRAME_TYPE", "New keyframe value must match the animation type.");
  if (animation.keyframes.length >= 1024)
    throw new CommandError("KEYFRAME_LIMIT", "Animation has reached the 1024-keyframe limit.");
  const atUs = irTimeUs(command.atUs);
  assertUniqueTime(animation, atUs);
  const easing = validEasing(command.easing) ?? "linear";
  animation.keyframes.push({ at: atUs, value: command.value, easing });
  animation.keyframes.sort((left, right) => left.at - right.at);
  context.patches.push({ ...command, atUs, easing });
  return finishCommand(context, command, `Added ${command.property} keyframe.`, [command.nodeId]);
}

function removeKeyframe(
  context: CommandContext,
  command: Extract<KeyframeCommand, { type: "keyframe.remove" }>,
  animation: IrAnimation,
): SemanticCommandPlan {
  if (!animation.keyframes[command.index])
    throw new CommandError("KEYFRAME_NOT_FOUND", "Keyframe binding was not found.");
  if (animation.keyframes.length <= 2)
    throw new CommandError("KEYFRAME_COUNT", "Animation must retain at least two keyframes.");
  animation.keyframes.splice(command.index, 1);
  context.patches.push(command);
  return finishCommand(context, command, `Removed ${command.property} keyframe.`, [command.nodeId]);
}

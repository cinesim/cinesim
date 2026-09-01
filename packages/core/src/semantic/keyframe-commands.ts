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
  if (command.atUs === undefined && command.value === undefined)
    throw new CommandError("KEYFRAME_EMPTY", "Keyframe edit must change time or value.");
  const animation = findAnimation(context, command.nodeId, command.property);
  const keyframe = animation?.keyframes[command.index];
  if (!animation || !keyframe)
    throw new CommandError("KEYFRAME_NOT_FOUND", "Keyframe binding was not found.");
  if (command.value && command.value.kind !== keyframe.value.kind)
    throw new CommandError("KEYFRAME_TYPE", "Keyframe value type cannot change.");
  const atUs = command.atUs === undefined ? undefined : irTimeUs(command.atUs);
  if (atUs !== undefined) keyframe.at = atUs;
  if (command.value !== undefined) keyframe.value = command.value;
  animation.keyframes.sort((left, right) => left.at - right.at);
  context.patches.push({
    type: "keyframe.set",
    nodeId: command.nodeId,
    property: command.property,
    index: command.index,
    ...(atUs === undefined ? {} : { atUs }),
    ...(command.value === undefined ? {} : { value: command.value }),
  });
  return finishCommand(context, command, `Updated ${command.property} keyframe.`, [command.nodeId]);
}

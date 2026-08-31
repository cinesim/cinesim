import type { IrClip, IrProgram, IrSceneNode, IrTrack, IrValue } from "@cinesim/ir";
import { CommandError } from "../commands/types";
import { finishCommand, propertyPatch } from "./command-helpers";
import type { CommandContext, PropertyCommand, SemanticCommandPlan } from "./command-types";

type ValueWriter<T> = (target: T, value: IrValue) => boolean;

const trackWriters: Readonly<Record<string, ValueWriter<IrTrack>>> = {
  name: (track, value) => {
    if (value.kind !== "string") return false;
    track.name = value.value;
    return true;
  },
  muted: (track, value) => {
    if (value.kind !== "boolean") return false;
    track.muted = value.value;
    return true;
  },
  locked: (track, value) => {
    if (value.kind !== "boolean") return false;
    track.locked = value.value;
    return true;
  },
};

const clipWriters: Readonly<Record<string, ValueWriter<IrClip>>> = {
  enabled: (clip, value) => {
    if (value.kind !== "boolean") return false;
    clip.enabled = value.value;
    return true;
  },
  opacity: (clip, value) => {
    if (value.kind !== "number") return false;
    clip.transform.opacity = value.value;
    return true;
  },
  x: (clip, value) => {
    if (value.kind !== "length") return false;
    clip.transform.x = value.value;
    return true;
  },
  y: (clip, value) => {
    if (value.kind !== "length") return false;
    clip.transform.y = value.value;
    return true;
  },
  scaleX: (clip, value) => {
    if (value.kind !== "number") return false;
    clip.transform.scaleX = value.value;
    return true;
  },
  scaleY: (clip, value) => {
    if (value.kind !== "number") return false;
    clip.transform.scaleY = value.value;
    return true;
  },
  rotation: (clip, value) => {
    if (value.kind !== "angle") return false;
    clip.transform.rotation = value.value;
    return true;
  },
  gain: (clip, value) => {
    if (value.kind !== "decibels") return false;
    clip.audio.gainDb = value.value;
    return true;
  },
  pan: (clip, value) => {
    if (value.kind !== "number") return false;
    clip.audio.pan = value.value;
    return true;
  },
  muted: (clip, value) => {
    if (value.kind !== "boolean") return false;
    clip.audio.muted = value.value;
    return true;
  },
};

function findScene(node: IrSceneNode, id: string): IrSceneNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findScene(child, id);
    if (found) return found;
  }
  return undefined;
}

function applySceneProperty(scene: IrSceneNode, property: string, value: IrValue): void {
  const current = scene.props[property];
  if (current !== undefined && current.kind !== value.kind) {
    throw new CommandError("INVALID_PROPERTY", `Expected ${current.kind}, received ${value.kind}`);
  }
  scene.props[property] = value;
}

function applyKnownProperty<T>(
  target: T,
  id: string,
  property: string,
  value: IrValue,
  writers: Readonly<Record<string, ValueWriter<T>>>,
): void {
  if (writers[property]?.(target, value)) return;
  throw new CommandError("INVALID_PROPERTY", `Invalid ${id}.${property} value`);
}

function findTrack(program: IrProgram, id: string): IrTrack | undefined {
  for (const composition of program.compositions) {
    const track = composition.timeline.tracks.find((candidate) => candidate.id === id);
    if (track) return track;
  }
  return undefined;
}

function findClip(program: IrProgram, id: string): IrClip | undefined {
  for (const composition of program.compositions) {
    for (const track of composition.timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === id);
      if (clip) return clip;
    }
  }
  return undefined;
}

function findSceneInProgram(program: IrProgram, id: string): IrSceneNode | undefined {
  for (const composition of program.compositions) {
    for (const track of composition.timeline.tracks) {
      for (const clip of track.clips) {
        const scene = clip.content && findScene(clip.content, id);
        if (scene) return scene;
      }
    }
  }
  return undefined;
}

function applyProperty(program: IrProgram, command: PropertyCommand): void {
  const composition = program.compositions.find((candidate) => candidate.id === command.nodeId);
  if (composition) {
    if (command.property === "background" && command.value.kind === "color") {
      composition.background = command.value.value;
      return;
    }
    throw new CommandError(
      "INVALID_PROPERTY",
      `Invalid ${composition.id}.${command.property} value`,
    );
  }
  const track = findTrack(program, command.nodeId);
  if (track) {
    applyKnownProperty(track, track.id, command.property, command.value, trackWriters);
    return;
  }
  const clip = findClip(program, command.nodeId);
  if (clip) {
    applyKnownProperty(clip, clip.id, command.property, command.value, clipWriters);
    return;
  }
  const scene = findSceneInProgram(program, command.nodeId);
  if (scene) {
    applySceneProperty(scene, command.property, command.value);
    return;
  }
  throw new CommandError("NODE_NOT_FOUND", `Semantic node not found: ${command.nodeId}`);
}

export function planPropertyCommand(
  context: CommandContext,
  command: PropertyCommand,
): SemanticCommandPlan {
  applyProperty(context.program, command);
  context.patches.push(
    propertyPatch(command.nodeId, command.property, command.value, command.scope ?? "instance"),
  );
  return finishCommand(context, command, `Updated ${command.property}`, [command.nodeId]);
}

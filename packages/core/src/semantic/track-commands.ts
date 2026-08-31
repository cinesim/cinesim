import type { IrTrack } from "@cinesim/ir";
import { CommandError } from "../commands/types";
import {
  allocateId,
  assertUnlocked,
  findTrack,
  finishCommand,
  propertyPatch,
} from "./command-helpers";
import type { CommandContext, SemanticCommandPlan, TrackCommand } from "./command-types";

function trackName(command: Extract<TrackCommand, { type: "track.add" }>, count: number): string {
  if (command.name?.trim()) return command.name.trim();
  const kind =
    command.kind === "overlay"
      ? "Titles"
      : `${command.kind[0]!.toUpperCase()}${command.kind.slice(1)}`;
  return `${kind} ${count + 1}`;
}

function addTrack(
  context: CommandContext,
  command: Extract<TrackCommand, { type: "track.add" }>,
): SemanticCommandPlan {
  const composition = context.program.compositions.find(
    (candidate) => candidate.id === command.sequenceId,
  );
  if (!composition) {
    throw new CommandError("SEQUENCE_NOT_FOUND", `Composition not found: ${command.sequenceId}`);
  }
  const id = allocateId(context, "track");
  const count = composition.timeline.tracks.filter((track) => track.kind === command.kind).length;
  const track: IrTrack = {
    id,
    kind: command.kind,
    name: trackName(command, count),
    muted: false,
    locked: false,
    clips: [],
    effects: [],
  };
  composition.timeline.tracks.push(track);
  context.patches.push({
    type: "node.insert",
    parentId: composition.timeline.id,
    node: { kind: "track", track },
  });
  return finishCommand(context, command, `Added ${track.name}`, [composition.id, id], {
    createdIds: [id],
  });
}

function updateTrack(
  context: CommandContext,
  command: Extract<TrackCommand, { type: "track.update" }>,
): SemanticCommandPlan {
  const { composition, track } = findTrack(context.program, command.trackId);
  if (command.name !== undefined) {
    const name = command.name.trim();
    if (!name) throw new CommandError("INVALID_NAME", "Track name cannot be empty");
    track.name = name;
    context.patches.push(propertyPatch(track.id, "name", { kind: "string", value: name }));
  }
  if (command.muted !== undefined) {
    track.muted = command.muted;
    context.patches.push(
      propertyPatch(track.id, "muted", { kind: "boolean", value: command.muted }),
    );
  }
  if (command.locked !== undefined) {
    track.locked = command.locked;
    context.patches.push(
      propertyPatch(track.id, "locked", { kind: "boolean", value: command.locked }),
    );
  }
  return finishCommand(context, command, `Updated ${track.name}`, [composition.id, track.id]);
}

function removeTrack(
  context: CommandContext,
  command: Extract<TrackCommand, { type: "track.remove" }>,
): SemanticCommandPlan {
  const { composition, track, index } = findTrack(context.program, command.trackId);
  assertUnlocked(track);
  if (track.clips.length > 0) {
    throw new CommandError("TRACK_NOT_EMPTY", `Track is not empty: ${track.name}`);
  }
  composition.timeline.tracks.splice(index, 1);
  context.patches.push({ type: "node.remove", nodeId: track.id });
  return finishCommand(context, command, `Removed ${track.name}`, [composition.id, track.id]);
}

function reorderTrack(
  context: CommandContext,
  command: Extract<TrackCommand, { type: "track.reorder" }>,
): SemanticCommandPlan {
  const { composition, track, index } = findTrack(context.program, command.trackId);
  if (command.index < 0 || command.index >= composition.timeline.tracks.length) {
    throw new CommandError("INVALID_TRACK_INDEX", `Invalid track index: ${command.index}`);
  }
  composition.timeline.tracks.splice(index, 1);
  composition.timeline.tracks.splice(command.index, 0, track);
  const next = composition.timeline.tracks[command.index + 1];
  context.patches.push({
    type: "node.move",
    nodeId: track.id,
    parentId: composition.timeline.id,
    ...(next === undefined ? {} : { anchor: `before:${next.id}` }),
  });
  return finishCommand(context, command, `Reordered ${track.name}`, [composition.id, track.id]);
}

export function planTrackCommand(
  context: CommandContext,
  command: TrackCommand,
): SemanticCommandPlan {
  switch (command.type) {
    case "track.add":
      return addTrack(context, command);
    case "track.update":
      return updateTrack(context, command);
    case "track.remove":
      return removeTrack(context, command);
    case "track.reorder":
      return reorderTrack(context, command);
  }
}

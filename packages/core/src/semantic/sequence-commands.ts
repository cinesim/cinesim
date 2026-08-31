import type { IrComposition, IrTrack } from "@cinesim/ir";
import { CommandError } from "./command-types";
import { allocateId, finishCommand, newClip } from "./command-helpers";
import type { CommandContext, SemanticCommandPlan, SequenceCommand } from "./command-types";
import { deleteTimelineRanges } from "./range-deletion";

function deleteRanges(
  context: CommandContext,
  command: Extract<SequenceCommand, { type: "sequence.deleteRanges" }>,
): SemanticCommandPlan {
  const result = deleteTimelineRanges(context, command.sequenceId, command.ranges, command.mode);
  return finishCommand(
    context,
    command,
    `${command.mode === "ripple" ? "Ripple" : "Lift"} deleted selected ranges`,
    result.changedIds,
    { createdIds: result.createdIds },
  );
}

function removeSequence(
  context: CommandContext,
  command: Extract<SequenceCommand, { type: "sequence.remove" }>,
): SemanticCommandPlan {
  const index = context.program.compositions.findIndex(
    (composition) => composition.id === command.sequenceId,
  );
  const composition = context.program.compositions[index];
  if (!composition) {
    throw new CommandError("SEQUENCE_NOT_FOUND", `Composition not found: ${command.sequenceId}`);
  }
  if (context.program.compositions.length === 1) {
    throw new CommandError("LAST_SEQUENCE", "A project must contain at least one composition");
  }
  const locked = composition.timeline.tracks.find((track) => track.locked);
  if (locked) throw new CommandError("TRACK_LOCKED", `Unlock ${locked.name} first`);
  context.program.compositions.splice(index, 1);
  context.patches.push({ type: "node.remove", nodeId: composition.id });
  const nextActive =
    context.program.activeCompositionId === composition.id
      ? [...context.program.compositions].sort((left, right) => left.id.localeCompare(right.id))[0]!
          .id
      : context.program.activeCompositionId;
  context.program.activeCompositionId = nextActive;
  return finishCommand(context, command, `Removed ${composition.name}`, [composition.id], {
    manifest: { activeCompositionId: nextActive },
  });
}

function emptyTrack(id: string, kind: "video" | "audio", name: string): IrTrack {
  return { id, kind, name, muted: false, locked: false, clips: [], effects: [] };
}

function appendAssetClips(
  context: CommandContext,
  command: Extract<SequenceCommand, { type: "sequence.createFromAssets" }>,
  videoTrack: IrTrack,
  audioTrack: IrTrack,
  createdIds: string[],
): void {
  let start = 0;
  for (const id of command.assetIds) {
    const asset = context.assetsById.get(id);
    if (!asset) throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${id}`);
    const primaryTrack = asset.kind === "audio" ? audioTrack : videoTrack;
    const primary = newClip(
      allocateId(context, "clip", createdIds),
      primaryTrack,
      asset,
      asset.kind === "audio" ? "audio" : "video",
      start,
      0,
      asset.durationUs,
    );
    primaryTrack.clips.push(primary);
    createdIds.push(primary.id);
    if (asset.kind === "video" && asset.hasAudio) {
      const audio = newClip(
        allocateId(context, "clip", createdIds),
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
      createdIds.push(audio.id);
    }
    start += asset.durationUs;
  }
}

function createSequence(
  context: CommandContext,
  command: Extract<SequenceCommand, { type: "sequence.createFromAssets" }>,
): SemanticCommandPlan {
  const template = context.program.compositions.find(
    (composition) => composition.id === context.program.activeCompositionId,
  )!;
  const sequenceId = allocateId(context, "sequence");
  const videoTrack = emptyTrack(allocateId(context, "track"), "video", "Video 1");
  const audioTrack = emptyTrack(allocateId(context, "track", [videoTrack.id]), "audio", "Audio 1");
  const createdIds = [sequenceId, videoTrack.id, audioTrack.id];
  appendAssetClips(context, command, videoTrack, audioTrack, createdIds);
  const composition: IrComposition = {
    id: sequenceId,
    name: command.name?.trim() || `Timeline ${context.program.compositions.length + 1}`,
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
  context.program.compositions.push(composition);
  context.program.activeCompositionId = composition.id;
  context.patches.push({
    type: "node.insert",
    parentId: "$program",
    node: { kind: "composition", composition },
  });
  return finishCommand(context, command, `Created ${composition.name}`, createdIds, {
    createdIds,
    manifest: { activeCompositionId: composition.id },
  });
}

export function planSequenceCommand(
  context: CommandContext,
  command: SequenceCommand,
): SemanticCommandPlan {
  switch (command.type) {
    case "sequence.deleteRanges":
      return deleteRanges(context, command);
    case "sequence.remove":
      return removeSequence(context, command);
    case "sequence.createFromAssets":
      return createSequence(context, command);
  }
}

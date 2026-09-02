import type { IrCaptionTrack } from "@cinesim/ir";
import {
  CommandError,
  type CaptionCommand,
  type CommandContext,
  type SemanticCommandPlan,
} from "./command-types";
import { allIds, finishCommand } from "./command-helpers";

function captionIds(track: IrCaptionTrack): string[] {
  return [track.id, ...track.cues.flatMap((cue) => [cue.id, ...cue.words.map(({ id }) => id)])];
}

export function planCaptionCommand(
  context: CommandContext,
  command: CaptionCommand,
): SemanticCommandPlan {
  const composition = context.program.compositions.find(({ id }) => id === command.sequenceId);
  if (!composition)
    throw new CommandError("SEQUENCE_NOT_FOUND", `Timeline not found: ${command.sequenceId}`);
  const track = structuredClone(command.track);
  const existingIndex = composition.timeline.captionTracks.findIndex(({ id }) => id === track.id);
  const existing = composition.timeline.captionTracks[existingIndex];
  const replacedIds = new Set(existing ? captionIds(existing) : []);
  const collision = captionIds(track).find(
    (id, index, ids) =>
      ids.indexOf(id) !== index || (allIds(context.program).includes(id) && !replacedIds.has(id)),
  );
  if (collision) throw new CommandError("DUPLICATE_ID", `ID already exists: ${collision}`);
  if (existing) {
    composition.timeline.captionTracks[existingIndex] = track;
    context.patches.push({
      type: "node.replace",
      nodeId: existing.id,
      nodes: [{ kind: "captiontrack", track }],
    });
  } else {
    composition.timeline.captionTracks.push(track);
    context.patches.push({
      type: "node.insert",
      parentId: composition.timeline.id,
      node: { kind: "captiontrack", track },
    });
  }
  return finishCommand(
    context,
    command,
    `${existing ? "Regenerated" : "Generated"} ${track.cues.length} caption cues`,
    captionIds(track),
    { createdIds: existing ? [] : captionIds(track) },
  );
}

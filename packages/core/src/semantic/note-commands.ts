import { irTimeUs, type IrTimelineNote } from "@cinesim/ir";
import type { EditorialNote } from "../project/types";
import {
  CommandError,
  type CommandContext,
  type NoteCommand,
  type SemanticCommandPlan,
} from "./command-types";
import { allIds, assertTime, finishCommand } from "./command-helpers";

const noteIdPattern = /^note_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;

function targetNotes(context: CommandContext, command: NoteCommand): readonly EditorialNote[] {
  if (command.target === "project") return context.projectNotes;
  if (command.target === "asset") {
    const asset = command.assetId ? context.assetsById.get(command.assetId) : undefined;
    if (!asset) throw new CommandError("ASSET_NOT_FOUND", "Asset note target is unavailable");
    return asset.notes ?? [];
  }
  const composition = context.program.compositions.find(({ id }) => id === command.sequenceId);
  if (!composition)
    throw new CommandError("SEQUENCE_NOT_FOUND", "Timeline note target is unavailable");
  return composition.timeline.notes;
}

function validateNote(note: EditorialNote): void {
  if (!noteIdPattern.test(note.id))
    throw new CommandError("INVALID_NOTE_ID", `Invalid note ID: ${note.id}`);
  if (!note.text.trim() || note.text.length > 20_000)
    throw new CommandError("INVALID_NOTE_TEXT", "A note must contain at most 20,000 characters");
}

function timelineNote(command: Extract<NoteCommand, { type: "note.upsert" }>): IrTimelineNote {
  const { note } = command;
  if (note.atUs === undefined)
    throw new CommandError("NOTE_TIME_REQUIRED", "Timeline notes require a start time");
  assertTime(note.atUs, "note.atUs");
  if (note.durationUs !== undefined) assertTime(note.durationUs, "note.durationUs");
  return {
    id: note.id,
    kind: note.kind,
    text: note.text.trim(),
    atUs: irTimeUs(note.atUs),
    ...(note.durationUs === undefined ? {} : { durationUs: irTimeUs(note.durationUs) }),
  };
}

function upsertNote(
  context: CommandContext,
  command: Extract<NoteCommand, { type: "note.upsert" }>,
): SemanticCommandPlan {
  validateNote(command.note);
  const existing = targetNotes(context, command).find(({ id }) => id === command.note.id);
  if (command.target === "timeline") {
    const composition = context.program.compositions.find(({ id }) => id === command.sequenceId)!;
    const note = timelineNote(command);
    const collision = allIds(context.program).includes(note.id) && !existing;
    if (collision) throw new CommandError("DUPLICATE_ID", `ID already exists: ${note.id}`);
    if (existing) {
      const index = composition.timeline.notes.findIndex(({ id }) => id === note.id);
      composition.timeline.notes[index] = note;
      context.patches.push({
        type: "node.replace",
        nodeId: note.id,
        nodes: [{ kind: "note", note }],
      });
    } else {
      composition.timeline.notes.push(note);
      context.patches.push({
        type: "node.insert",
        parentId: composition.timeline.id,
        node: { kind: "note", note },
      });
    }
  }
  return finishCommand(
    context,
    command,
    `${existing ? "Updated" : "Added"} note`,
    [command.note.id],
    {
      createdIds: existing ? [] : [command.note.id],
    },
  );
}

function removeNote(
  context: CommandContext,
  command: Extract<NoteCommand, { type: "note.remove" }>,
): SemanticCommandPlan {
  if (!noteIdPattern.test(command.noteId))
    throw new CommandError("INVALID_NOTE_ID", `Invalid note ID: ${command.noteId}`);
  const existing = targetNotes(context, command).find(({ id }) => id === command.noteId);
  if (!existing) throw new CommandError("NOTE_NOT_FOUND", `Note not found: ${command.noteId}`);
  if (command.target === "timeline") {
    const composition = context.program.compositions.find(({ id }) => id === command.sequenceId)!;
    composition.timeline.notes = composition.timeline.notes.filter(
      ({ id }) => id !== command.noteId,
    );
    context.patches.push({ type: "node.remove", nodeId: command.noteId });
  }
  return finishCommand(context, command, "Removed note", [command.noteId]);
}

export function planNoteCommand(
  context: CommandContext,
  command: NoteCommand,
): SemanticCommandPlan {
  return command.type === "note.upsert"
    ? upsertNote(context, command)
    : removeNote(context, command);
}

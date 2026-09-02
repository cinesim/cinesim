import type { IrProgram } from "@cinesim/ir";
import type { Asset } from "../project/types";
import { planAssetCommand } from "./asset-commands";
import { planClipCommand } from "./clip-commands";
import { planCaptionCommand } from "./caption-commands";
import { createCommandContext } from "./command-helpers";
import type {
  AssetCommand,
  CaptionCommand,
  KeyframeCommand,
  ClipCommand,
  NoteCommand,
  PropertyCommand,
  SemanticCommandPlan,
  SemanticEditorCommand,
  SequenceCommand,
  TrackCommand,
} from "./command-types";
import { CommandError } from "./command-types";
import { planPropertyCommand } from "./property-command";
import { planNoteCommand } from "./note-commands";
import { planSequenceCommand } from "./sequence-commands";
import { planTrackCommand } from "./track-commands";
import { planKeyframeCommand } from "./keyframe-commands";

export type { SemanticCommandPlan, SemanticEditorCommand } from "./command-types";

export function planSemanticCommand(
  inputProgram: IrProgram,
  assets: readonly Asset[],
  command: SemanticEditorCommand,
  projectNotes: readonly import("../project/types").EditorialNote[] = [],
): SemanticCommandPlan {
  const context = createCommandContext(inputProgram, assets, projectNotes);
  const family = command.type.split(".", 1)[0];
  switch (family) {
    case "asset":
      return planAssetCommand(context, command as AssetCommand);
    case "property":
      return planPropertyCommand(context, command as PropertyCommand);
    case "note":
      return planNoteCommand(context, command as NoteCommand);
    case "track":
      return planTrackCommand(context, command as TrackCommand);
    case "clip":
      return planClipCommand(context, command as ClipCommand);
    case "caption":
      return planCaptionCommand(context, command as CaptionCommand);
    case "keyframe":
      return planKeyframeCommand(context, command as KeyframeCommand);
    case "sequence":
      return planSequenceCommand(context, command as SequenceCommand);
    default:
      throw new CommandError(
        "UNSUPPORTED_COMMAND",
        `Unsupported semantic command: ${command.type}`,
      );
  }
}

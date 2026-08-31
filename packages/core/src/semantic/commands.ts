import type { IrProgram } from "@cinesim/ir";
import type { Asset } from "../project/types";
import { planAssetCommand } from "./asset-commands";
import { planClipCommand } from "./clip-commands";
import { createCommandContext } from "./command-helpers";
import type {
  AssetCommand,
  ClipCommand,
  PropertyCommand,
  SemanticCommandPlan,
  SemanticEditorCommand,
  SequenceCommand,
  TrackCommand,
} from "./command-types";
import { CommandError } from "./command-types";
import { planPropertyCommand } from "./property-command";
import { planSequenceCommand } from "./sequence-commands";
import { planTrackCommand } from "./track-commands";

export type { SemanticCommandPlan, SemanticEditorCommand } from "./command-types";

export function planSemanticCommand(
  inputProgram: IrProgram,
  assets: readonly Asset[],
  command: SemanticEditorCommand,
): SemanticCommandPlan {
  const context = createCommandContext(inputProgram, assets);
  const family = command.type.split(".", 1)[0];
  switch (family) {
    case "asset":
      return planAssetCommand(context, command as AssetCommand);
    case "property":
      return planPropertyCommand(context, command as PropertyCommand);
    case "track":
      return planTrackCommand(context, command as TrackCommand);
    case "clip":
      return planClipCommand(context, command as ClipCommand);
    case "sequence":
      return planSequenceCommand(context, command as SequenceCommand);
    default:
      throw new CommandError(
        "UNSUPPORTED_COMMAND",
        `Unsupported semantic command: ${command.type}`,
      );
  }
}

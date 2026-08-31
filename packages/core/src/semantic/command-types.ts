import type { EditScope, IrProgram, IrValue, SemanticPatch } from "@cinesim/ir";
import type { EditorCommand } from "../commands/types";
import type { Asset, TimeUs } from "../project/types";

export type SemanticEditorCommand =
  | EditorCommand
  | {
      type: "property.set";
      nodeId: string;
      property: string;
      value: IrValue;
      scope?: EditScope;
    }
  | { type: "clip.slip"; clipId: string; sourceStartUs: TimeUs }
  | { type: "clip.duplicate"; clipId: string; timelineStartUs?: TimeUs; trackId?: string }
  | { type: "clip.link"; clipId: string; linkedClipId: string }
  | { type: "clip.unlink"; clipId: string };

export interface SemanticCommandPlan {
  command: SemanticEditorCommand;
  program: IrProgram;
  patches: SemanticPatch[];
  manifest: { activeCompositionId?: string };
  changedIds: string[];
  createdIds: string[];
  summary: string;
}

export interface CommandContext {
  program: IrProgram;
  assets: readonly Asset[];
  assetsById: ReadonlyMap<string, Asset>;
  patches: SemanticPatch[];
}

export type AssetCommand = Extract<
  SemanticEditorCommand,
  { type: "asset.import" | "asset.remove" | "asset.setSource" }
>;
export type ClipCommand = Extract<SemanticEditorCommand, { type: `clip.${string}` }>;
export type PropertyCommand = Extract<SemanticEditorCommand, { type: "property.set" }>;
export type SequenceCommand = Extract<SemanticEditorCommand, { type: `sequence.${string}` }>;
export type TrackCommand = Extract<SemanticEditorCommand, { type: `track.${string}` }>;

import type { EditScope, IrCaptionTrack, IrProgram, IrValue, SemanticPatch } from "@cinesim/ir";
import type { AssetId, ClipId, SequenceId, TrackId } from "../ids";
import type { Asset, AssetSource, EditorialNote, TimeUs, Track, Transform } from "../project/types";

export interface EditableNote extends EditorialNote {
  atUs?: TimeUs;
  durationUs?: TimeUs;
}

export interface TimelineRange {
  startUs: TimeUs;
  endUs: TimeUs;
}

export type EditorCommand =
  | { type: "asset.import"; asset: Asset }
  | { type: "asset.setSource"; assetId: AssetId; source: AssetSource }
  | { type: "asset.remove"; assetIds: AssetId[] }
  | {
      type: "sequence.createFromAssets";
      assetIds: AssetId[];
      name?: string;
      width?: number;
      height?: number;
      frameRate?: number;
    }
  | { type: "sequence.remove"; sequenceId: SequenceId }
  | {
      type: "sequence.deleteRanges";
      sequenceId: SequenceId;
      ranges: TimelineRange[];
      mode: "lift" | "ripple";
    }
  | {
      type: "track.add";
      sequenceId: SequenceId;
      kind: Track["kind"];
      name?: string;
    }
  | {
      type: "track.update";
      trackId: TrackId;
      name?: string;
      muted?: boolean;
      locked?: boolean;
    }
  | { type: "track.remove"; trackId: TrackId }
  | { type: "track.reorder"; trackId: TrackId; index: number }
  | {
      type: "clip.add";
      trackId: TrackId;
      assetId: AssetId;
      timelineStartUs: TimeUs;
      sourceStartUs?: TimeUs;
      sourceEndUs?: TimeUs;
      transform?: Partial<Transform>;
      audioTrackId?: TrackId;
    }
  | { type: "clip.remove"; clipId: ClipId }
  | { type: "clip.move"; clipId: ClipId; timelineStartUs: TimeUs; trackId?: TrackId }
  | { type: "clip.trimStart"; clipId: ClipId; atUs: TimeUs }
  | { type: "clip.trimEnd"; clipId: ClipId; atUs: TimeUs }
  | {
      type: "clip.splitEdit";
      clipId: ClipId;
      component: "audio" | "video";
      edge: "start" | "end";
      atUs: TimeUs;
    }
  | { type: "clip.setFade"; clipId: ClipId; edge: "in" | "out"; durationUs: TimeUs }
  | { type: "clip.split"; clipId: ClipId; atUs: TimeUs };

export class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export type SemanticEditorCommand =
  | EditorCommand
  | {
      type: "caption.generate";
      sequenceId: SequenceId;
      track: IrCaptionTrack;
    }
  | {
      type: "note.upsert";
      target: "project" | "asset" | "timeline";
      assetId?: AssetId;
      sequenceId?: SequenceId;
      note: EditableNote;
    }
  | {
      type: "note.remove";
      target: "project" | "asset" | "timeline";
      assetId?: AssetId;
      sequenceId?: SequenceId;
      noteId: string;
    }
  | {
      type: "property.set";
      nodeId: string;
      property: string;
      value: IrValue;
      scope?: EditScope;
    }
  | {
      type: "property.setMany";
      nodeId: string;
      updates: Array<{ property: string; value: IrValue }>;
      scope?: EditScope;
    }
  | {
      type: "keyframe.set";
      nodeId: string;
      property: string;
      index: number;
      atUs?: TimeUs;
      value?: IrValue;
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
  projectNotes: readonly EditorialNote[];
  patches: SemanticPatch[];
}

export type AssetCommand = Extract<
  SemanticEditorCommand,
  { type: "asset.import" | "asset.remove" | "asset.setSource" }
>;
export type ClipCommand = Extract<SemanticEditorCommand, { type: `clip.${string}` }>;
export type CaptionCommand = Extract<SemanticEditorCommand, { type: `caption.${string}` }>;
export type KeyframeCommand = Extract<SemanticEditorCommand, { type: `keyframe.${string}` }>;
export type PropertyCommand = Extract<SemanticEditorCommand, { type: `property.${string}` }>;
export type NoteCommand = Extract<SemanticEditorCommand, { type: `note.${string}` }>;
export type SequenceCommand = Extract<SemanticEditorCommand, { type: `sequence.${string}` }>;
export type TrackCommand = Extract<SemanticEditorCommand, { type: `track.${string}` }>;

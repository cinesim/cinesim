import type { AssetId, ClipId, SequenceId, TrackId } from "../ids";
import type { Asset, TimeUs, Track, Transform } from "../project/types";

export type EditorCommand =
  | { type: "asset.import"; asset: Asset }
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
    }
  | { type: "clip.remove"; clipId: ClipId }
  | { type: "clip.move"; clipId: ClipId; timelineStartUs: TimeUs; trackId?: TrackId }
  | { type: "clip.trimStart"; clipId: ClipId; atUs: TimeUs }
  | { type: "clip.trimEnd"; clipId: ClipId; atUs: TimeUs }
  | { type: "clip.split"; clipId: ClipId; atUs: TimeUs };

export interface CommandResult {
  project: import("../project/types").Project;
  command: EditorCommand;
  changedIds: string[];
  createdIds: string[];
  summary: string;
}

export class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

import type { AssetId, ClipId, SequenceId, TrackId } from "../ids";
import type { Asset, AssetSource, TimeUs, Track, Transform } from "../project/types";

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
      /** Adds the embedded audio as a reciprocal linked clip in one command. */
      audioTrackId?: TrackId;
    }
  | { type: "clip.remove"; clipId: ClipId }
  | { type: "clip.move"; clipId: ClipId; timelineStartUs: TimeUs; trackId?: TrackId }
  | { type: "clip.trimStart"; clipId: ClipId; atUs: TimeUs }
  | { type: "clip.trimEnd"; clipId: ClipId; atUs: TimeUs }
  | {
      type: "clip.setFade";
      clipId: ClipId;
      edge: "in" | "out";
      durationUs: TimeUs;
    }
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

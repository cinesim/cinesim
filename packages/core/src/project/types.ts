import type { AssetId, ClipId, ProjectId, SequenceId, TrackId } from "../ids";

export type TimeUs = number;

export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  fit: "contain" | "cover" | "fill";
}

export interface LocalAssetSource {
  kind: "local";
  path: string;
}

export interface Asset {
  id: AssetId;
  kind: "video" | "audio" | "image";
  name: string;
  source: LocalAssetSource;
  durationUs: TimeUs;
  width?: number;
  height?: number;
  frameRate?: number;
  hasAudio?: boolean;
}

export interface Clip {
  id: ClipId;
  assetId: AssetId;
  timelineStartUs: TimeUs;
  sourceStartUs: TimeUs;
  sourceEndUs: TimeUs;
  transform: Transform;
}

export interface Track {
  id: TrackId;
  name: string;
  kind: "video" | "audio" | "overlay";
  muted: boolean;
  locked: boolean;
  clips: Clip[];
}

export interface Sequence {
  id: SequenceId;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  tracks: Track[];
}

export interface Project {
  version: 1;
  id: ProjectId;
  name: string;
  activeSequenceId: SequenceId;
  assets: Asset[];
  sequences: Sequence[];
}

export interface ProjectSettings {
  version: 1;
  autosave: boolean;
  defaultFilmstripIntervalSeconds: number;
  previewQuality: "full" | "half" | "quarter";
  backgroundColor: string;
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  fit: "contain",
};

export const DEFAULT_SETTINGS: ProjectSettings = {
  version: 1,
  autosave: true,
  defaultFilmstripIntervalSeconds: 5,
  previewQuality: "half",
  backgroundColor: "#09090b",
};

export function clipDurationUs(clip: Clip): TimeUs {
  return clip.sourceEndUs - clip.sourceStartUs;
}

export function clipEndUs(clip: Clip): TimeUs {
  return clip.timelineStartUs + clipDurationUs(clip);
}

export function sequenceDurationUs(sequence: Sequence): TimeUs {
  return sequence.tracks.reduce(
    (maximum, track) =>
      track.clips.reduce((trackMaximum, clip) => Math.max(trackMaximum, clipEndUs(clip)), maximum),
    0,
  );
}

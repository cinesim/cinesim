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

export type CloudProjectId = `cloud_project_${string}`;
export type CloudAssetId = `cloud_asset_${string}`;

export interface CloudAssetSource {
  kind: "cloud";
  cloudAssetId: CloudAssetId;
}

export type AssetSource = LocalAssetSource | CloudAssetSource;

export interface Asset {
  id: AssetId;
  kind: "video" | "audio" | "image";
  name: string;
  source: AssetSource;
  durationUs: TimeUs;
  width?: number;
  height?: number;
  frameRate?: number;
  hasAudio?: boolean;
}

export interface Clip {
  id: ClipId;
  assetId: AssetId;
  /** Identifies the source component represented by this canonical clip. */
  mediaKind: "video" | "audio";
  /** Reciprocal link to the other component of an imported A/V clip. */
  linkedClipId?: ClipId;
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

/**
 * Returns whether an asset's primary component can be represented by a track.
 */
export function isAssetCompatibleWithTrack(
  assetKind: Asset["kind"],
  trackKind: Track["kind"],
): boolean {
  return assetKind === "audio" ? trackKind === "audio" : trackKind !== "audio";
}

export function isAssetMediaCompatibleWithTrack(
  asset: Asset,
  mediaKind: NonNullable<Clip["mediaKind"]>,
  trackKind: Track["kind"],
): boolean {
  if (mediaKind === "audio")
    return trackKind === "audio" && (asset.kind === "audio" || asset.hasAudio === true);
  return trackKind !== "audio" && asset.kind !== "audio";
}

export function clipCarriesAudio(asset: Asset, clip: Clip, track: Track): boolean {
  return (
    track.kind === "audio" &&
    clip.mediaKind === "audio" &&
    (asset.kind === "audio" || asset.hasAudio === true)
  );
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
  cloudProjectId?: CloudProjectId;
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
  proxyGeneration: "automatic" | "manual";
  proxyProfile: "space-saver" | "balanced" | "high-quality" | "custom";
  proxyMaxLongEdge: number;
  proxyFrameRateCap: 30 | 60;
  proxyQuality: "low" | "medium" | "high";
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
  proxyGeneration: "automatic",
  proxyProfile: "balanced",
  proxyMaxLongEdge: 1280,
  proxyFrameRateCap: 60,
  proxyQuality: "medium",
};

export function clipDurationUs(clip: Clip): TimeUs {
  return clip.sourceEndUs - clip.sourceStartUs;
}

export function clipEndUs(clip: Clip): TimeUs {
  return clip.timelineStartUs + clipDurationUs(clip);
}

export function canSplitClipAt(clip: Clip, atUs: TimeUs): boolean {
  return Number.isSafeInteger(atUs) && atUs > clip.timelineStartUs && atUs < clipEndUs(clip);
}

export function sequenceDurationUs(sequence: Sequence): TimeUs {
  return sequence.tracks.reduce(
    (maximum, track) =>
      track.clips.reduce((trackMaximum, clip) => Math.max(trackMaximum, clipEndUs(clip)), maximum),
    0,
  );
}

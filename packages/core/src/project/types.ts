import type { AssetId, ClipId, ProjectId, SequenceId, TrackId } from "../ids";

declare const TIME_US: unique symbol;
declare const TIME_SECONDS: unique symbol;
declare const TIME_MILLISECONDS: unique symbol;

export type TimeUs = number & { readonly [TIME_US]: "TimeUs" };
export type TimeSeconds = number & { readonly [TIME_SECONDS]: "TimeSeconds" };
export type TimeMilliseconds = number & { readonly [TIME_MILLISECONDS]: "TimeMilliseconds" };

export function timeUs(value: number): TimeUs {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Microsecond time must be a non-negative safe integer");
  }
  return value as TimeUs;
}

export function timeSeconds(value: number): TimeSeconds {
  if (!Number.isFinite(value)) throw new RangeError("Seconds must be finite");
  return value as TimeSeconds;
}

export function timeMilliseconds(value: number): TimeMilliseconds {
  if (!Number.isFinite(value)) throw new RangeError("Milliseconds must be finite");
  return value as TimeMilliseconds;
}

export function secondsToTimeUs(seconds: TimeSeconds): TimeUs {
  return timeUs(Math.round(seconds * 1_000_000));
}

export function millisecondsToTimeUs(milliseconds: TimeMilliseconds): TimeUs {
  return timeUs(Math.round(milliseconds * 1_000));
}

export function timeUsToSeconds(value: TimeUs): TimeSeconds {
  return timeSeconds(value / 1_000_000);
}

export function timeUsToMilliseconds(value: TimeUs): TimeMilliseconds {
  return timeMilliseconds(value / 1_000);
}

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
  /** Timeline duration. Canonical source duration is independent from playback rate. */
  durationUs?: TimeUs;
  sourceStartUs: TimeUs;
  sourceEndUs: TimeUs;
  playbackRate?: number;
  /** Linear fade from silence/transparent at the clip's timeline start. */
  fadeInUs?: TimeUs;
  /** Linear fade to silence/transparent at the clip's timeline end. */
  fadeOutUs?: TimeUs;
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

export interface Sequence {
  id: SequenceId;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  tracks: Track[];
}

export interface Project {
  id: ProjectId;
  cloudProjectId?: CloudProjectId;
  name: string;
  activeSequenceId: SequenceId;
  assets: Asset[];
  sequences: Sequence[];
}

export interface ProjectSettings {
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

export const DEFAULT_SETTINGS: ProjectSettings = {
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
  return clip.durationUs ?? timeUs(clip.sourceEndUs - clip.sourceStartUs);
}

export function clipEndUs(clip: Clip): TimeUs {
  return timeUs(clip.timelineStartUs + clipDurationUs(clip));
}

export function canSplitClipAt(clip: Clip, atUs: TimeUs): boolean {
  return Number.isSafeInteger(atUs) && atUs > clip.timelineStartUs && atUs < clipEndUs(clip);
}

export function sequenceDurationUs(sequence: Sequence): TimeUs {
  return timeUs(
    sequence.tracks.reduce(
      (maximum, track) =>
        track.clips.reduce(
          (trackMaximum, clip) => Math.max(trackMaximum, clipEndUs(clip)),
          maximum,
        ),
      0,
    ),
  );
}

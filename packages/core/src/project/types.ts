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
  rotation: number;
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

export type DecoderAvailability = "supported" | "unsupported" | "unknown";

export interface AssetFrameRateMetadata {
  mode: "constant" | "variable";
  nominal: number;
  minimum: number;
  maximum: number;
  average: number;
  probedFrames: number;
}

export interface AssetColorMetadata {
  primaries?: string;
  transfer?: string;
  matrix?: string;
  fullRange?: boolean;
  bitDepth?: number;
  hdr: boolean;
  uncertain: boolean;
}

export interface AssetVideoMetadata {
  codec?: string;
  codecParameters?: string;
  internalCodecId?: string;
  decoderAvailability: DecoderAvailability;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  pixelAspectRatio: { numerator: number; denominator: number };
  rotationDegrees: number;
  frameRate: AssetFrameRateMetadata;
  color: AssetColorMetadata;
}

export interface AssetAudioMetadata {
  codec?: string;
  codecParameters?: string;
  internalCodecId?: string;
  decoderAvailability: DecoderAvailability;
  sampleRate: number;
  channels: number;
  channelLayout: string;
}

export interface AssetTechnicalMetadata {
  containerMimeType: string;
  durationSeconds: number;
  compatibility: "supported" | "partial" | "unsupported" | "unknown";
  video?: AssetVideoMetadata;
  audio?: AssetAudioMetadata;
}

export interface AssetInputColorInterpretation {
  policy: "source-metadata" | "assume-rec709";
}

export const EDITORIAL_NOTE_KINDS = [
  "story-intent",
  "scene",
  "continuity",
  "edit-task",
  "review-feedback",
  "general",
] as const;

export type EditorialNoteKind = (typeof EDITORIAL_NOTE_KINDS)[number];

export interface EditorialNote {
  id: string;
  kind: EditorialNoteKind;
  text: string;
}

export interface TimelineNote extends EditorialNote {
  atUs: TimeUs;
  durationUs?: TimeUs;
}

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
  technical?: AssetTechnicalMetadata;
  inputColor?: AssetInputColorInterpretation;
  notes?: EditorialNote[];
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
  gainDb?: number;
  pan?: number;
  muted?: boolean;
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
  notes: TimelineNote[];
}

export interface Project {
  id: ProjectId;
  cloudProjectId?: CloudProjectId;
  name: string;
  activeSequenceId: SequenceId;
  assets: Asset[];
  sequences: Sequence[];
  notes: EditorialNote[];
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
  compilerStrict: boolean;
  workingColorSpace: "linear-rec709";
  outputColorSpace: "rec709-sdr";
  toneMapping: "automatic" | "off";
  uncertainColorHandling: "warn" | "assume-rec709";
}

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

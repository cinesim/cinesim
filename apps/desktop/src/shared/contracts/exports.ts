import type { TimeUs } from "@cinesim/core";
import type { DerivedProjectScope } from "./derived-media";

export type ExportPresetId = "h264-aac-sdr-1080p" | "h264-aac-sdr-source";
export type ExportJobState = "queued" | "rendering" | "completed" | "canceled" | "failed";

export interface ExportPreset {
  id: ExportPresetId;
  label: string;
  container: "mp4";
  videoCodec: "avc";
  audioCodec: "aac";
  colorSpace: "rec709-sdr";
  maximumLongEdge: number | null;
  sampleRate: 48_000;
  audioChannels: 2;
}

export interface ExportStartRequest {
  sequenceId?: string;
  presetId: ExportPresetId;
  startUs?: TimeUs;
  endUs?: TimeUs;
  fileName?: string;
}

export interface ExportJobSnapshot {
  id: string;
  state: ExportJobState;
  sequenceId: string;
  presetId: ExportPresetId;
  startUs: TimeUs;
  endUs: TimeUs;
  width: number;
  height: number;
  frameRate: number;
  progress: number;
  acceptedGeneration: string;
  outputPath?: string;
  bytes?: number;
  failureCode?: string;
  detail?: string;
}

export interface ExportRenderRequest {
  job: ExportJobSnapshot;
  projectScope: DerivedProjectScope;
}

export interface ExportRenderCompletion {
  jobId: string;
  bytes: number;
  videoFrames: number;
  audioFrames: number;
}

export interface ExportRenderFailure {
  jobId: string;
  code: string;
  detail: string;
}

export interface ExportCapabilitySnapshot {
  presets: ExportPreset[];
  rendererRequired: true;
  maximumConcurrentJobs: 1;
}

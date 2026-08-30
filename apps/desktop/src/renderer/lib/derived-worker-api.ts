export interface GenerateDerivedRequest {
  type: "generate";
  jobId: string;
  assetId: string;
  projectScope: DerivedProjectScope;
  durationUs: TimeUs;
  kinds: ("thumbnail" | "filmstrip" | "waveform")[];
  thumbnailSourceTimeUs?: TimeUs;
}

export interface CancelDerivedRequest {
  type: "cancel";
  jobId: string;
}

export interface GenerateProxyRequest {
  type: "proxy";
  jobId: string;
  assetId: string;
  projectScope: DerivedProjectScope;
  width: number;
  height: number;
  frameRate?: number;
  assetKind: "video" | "audio";
  maxLongEdge: number;
  frameRateCap: 30 | 60;
  quality: "low" | "medium" | "high";
}

export interface ProxyChunkAck {
  type: "proxy-chunk-ack";
  jobId: string;
  chunkId: number;
  error?: string;
}

export interface SetProxyPausedRequest {
  type: "proxy-pause" | "proxy-resume";
  jobId: string;
}

export interface SetPerceptionPausedRequest {
  type: "perception-pause" | "perception-resume";
  jobId: string;
}

export interface GenerateTranscriptRequest {
  type: "transcript";
  jobId: string;
  assetId: string;
  projectScope: DerivedProjectScope;
  durationUs: TimeUs;
  chunkDurationUs: TimeUs;
}

export interface TranscriptChunkAck {
  type: "transcript-chunk-ack";
  jobId: string;
  chunkIndex: number;
  error?: string;
}

export interface SetTranscriptPausedRequest {
  type: "transcript-pause" | "transcript-resume";
  jobId: string;
}

export type DerivedWorkerRequest =
  | GenerateDerivedRequest
  | GenerateProxyRequest
  | CancelDerivedRequest
  | ProxyChunkAck
  | SetProxyPausedRequest
  | SetPerceptionPausedRequest
  | GenerateTranscriptRequest
  | TranscriptChunkAck
  | SetTranscriptPausedRequest;

export type DerivedWorkerResponse =
  | {
      type: "activity";
      jobId: string;
      stage: DerivedWorkerStage;
      elapsedMs: number;
      completedSamples?: number;
      totalSamples?: number;
    }
  | {
      type: "progress";
      jobId: string;
      progress: number;
      stage: "thumbnail" | "filmstrip" | "waveform";
    }
  | {
      type: "thumbnail-complete";
      jobId: string;
      thumbnail: ArrayBuffer;
      sourceTimeUs: TimeUs;
    }
  | {
      type: "filmstrip-complete";
      jobId: string;
      filmstrip: ArrayBuffer;
      tileTimesUs: TimeUs[];
      columns: number;
      rows: number;
      tileWidth: number;
      tileHeight: number;
    }
  | {
      type: "waveform-complete";
      jobId: string;
      waveform: ArrayBuffer;
      peakCount: number;
      waveformFormatVersion: number;
    }
  | { type: "perception-complete"; jobId: string; samplingLatencyMs: number }
  | { type: "failed"; jobId: string; failureCode: string; detail: string }
  | {
      type: "proxy-chunk";
      jobId: string;
      chunkId: number;
      offset: number;
      data: ArrayBuffer;
    }
  | { type: "proxy-progress"; jobId: string; progress: number }
  | { type: "proxy-complete"; jobId: string; bytes: number }
  | {
      type: "transcript-progress";
      jobId: string;
      progress: number;
    }
  | {
      type: "transcript-chunk";
      jobId: string;
      chunkIndex: number;
      sourceStartUs: TimeUs;
      sourceEndUs: TimeUs;
      data: ArrayBuffer;
    }
  | { type: "transcript-complete"; jobId: string };
import type { TimeUs } from "@cinesim/core";
import type { DerivedProjectScope, DerivedWorkerStage } from "../../shared/api";

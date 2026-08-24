export interface GenerateDerivedRequest {
  type: "generate";
  jobId: string;
  assetId: string;
  projectScope: DerivedProjectScope;
  durationUs: number;
  kinds: ("thumbnail" | "filmstrip")[];
  thumbnailSourceTimeUs?: number;
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

export type DerivedWorkerRequest =
  | GenerateDerivedRequest
  | GenerateProxyRequest
  | CancelDerivedRequest
  | ProxyChunkAck
  | SetProxyPausedRequest;

export type DerivedWorkerResponse =
  | {
      type: "activity";
      jobId: string;
      stage: DerivedWorkerStage;
      elapsedMs: number;
      completedSamples?: number;
      totalSamples?: number;
    }
  | { type: "progress"; jobId: string; progress: number; stage: "thumbnail" | "filmstrip" }
  | {
      type: "thumbnail-complete";
      jobId: string;
      thumbnail: ArrayBuffer;
      sourceTimeUs: number;
    }
  | {
      type: "filmstrip-complete";
      jobId: string;
      filmstrip: ArrayBuffer;
      tileTimesUs: number[];
      columns: number;
      rows: number;
      tileWidth: number;
      tileHeight: number;
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
  | { type: "proxy-complete"; jobId: string; bytes: number };
import type { DerivedProjectScope, DerivedWorkerStage } from "../../shared/api";

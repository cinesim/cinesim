export interface GenerateDerivedRequest {
  type: "generate";
  jobId: string;
  assetId: string;
  durationUs: number;
}

export interface CancelDerivedRequest {
  type: "cancel";
  jobId: string;
}

export type DerivedWorkerRequest = GenerateDerivedRequest | CancelDerivedRequest;

export type DerivedWorkerResponse =
  | { type: "progress"; jobId: string; progress: number; stage: "thumbnail" | "filmstrip" }
  | {
      type: "complete";
      jobId: string;
      thumbnail: ArrayBuffer;
      filmstrip: ArrayBuffer;
      sourceTimeUs: number;
      tileTimesUs: number[];
      columns: number;
      rows: number;
      tileWidth: number;
      tileHeight: number;
      samplingLatencyMs: number;
    }
  | { type: "failed"; jobId: string; failureCode: string; detail: string };

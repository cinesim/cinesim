export interface DerivedProjectScope {
  cacheKey: string;
  epoch: string;
}

export type DerivedArtifactKind = "thumbnail" | "filmstrip" | "waveform" | "proxy";
export type DerivedArtifactState = "missing" | "queued" | "running" | "ready" | "failed";

export interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  edgeHash: string;
}

export interface DerivedArtifactSnapshot {
  state: DerivedArtifactState;
  bytes?: number;
  progress?: number;
  failureCode?: string;
  updatedAt?: string;
  lastAccessAt?: string;
  sourceTimeUs?: number;
  tileTimesUs?: number[];
  columns?: number;
  rows?: number;
  tileWidth?: number;
  tileHeight?: number;
  peakCount?: number;
  waveformFormatVersion?: number;
  profileId?: string;
}

export interface SourcePerformanceSnapshot {
  observations: number;
  warmSeekP50Ms?: number;
  warmSeekP95Ms?: number;
  deadlineMissRate?: number;
  requestsReceived: number;
  requestsCoalesced: number;
  framesPresented: number;
  framesObsolete: number;
}

export interface DerivedAssetSnapshot {
  assetId: string;
  fingerprintStatus: "current" | "stale" | "missing";
  thumbnail: DerivedArtifactSnapshot;
  filmstrip: DerivedArtifactSnapshot;
  waveform: DerivedArtifactSnapshot;
  proxy: DerivedArtifactSnapshot;
  performance: {
    original: SourcePerformanceSnapshot;
    proxy?: SourcePerformanceSnapshot;
  };
}

export interface DerivedMediaEvent {
  at: string;
  assetId?: string;
  kind: string;
  detail: string;
}

export type DerivedWorkerStage =
  | "scheduled"
  | "input-opening"
  | "container-ready"
  | "track-ready"
  | "decoder-ready"
  | "thumbnail-sampling"
  | "thumbnail-encoding"
  | "thumbnail-ready"
  | "filmstrip-sampling"
  | "filmstrip-encoding"
  | "filmstrip-ready"
  | "waveform-decoding"
  | "waveform-encoding"
  | "waveform-ready"
  | "proxy-converting"
  | "completed"
  | "failed";

export interface DerivedWorkerActivity {
  jobId: string;
  assetId: string;
  jobKind: "perception" | "proxy";
  stage: DerivedWorkerStage;
  elapsedMs: number;
  completedSamples?: number;
  totalSamples?: number;
  failureCode?: string;
  detail?: string;
}

export interface DerivedRuntimeSnapshot {
  activeJob?: {
    jobId: string;
    assetId: string;
    jobKind: "perception" | "proxy";
    stage: DerivedWorkerStage;
    progress: number;
    elapsedMs: number;
    startedAt: string;
    lastActivityAt: string;
    completedSamples?: number;
    totalSamples?: number;
  };
  lastJob?: {
    assetId: string;
    jobKind: "perception" | "proxy";
    stage: "completed" | "failed";
    durationMs: number;
    finishedAt: string;
    failureCode?: string;
  };
  protocol: {
    requests: number;
    rangeRequests: number;
    bytesRead: number;
    averageLatencyMs: number;
    lastLatencyMs?: number;
    lastBytesRead?: number;
    lastAssetId?: string;
    errors: number;
  };
}

export interface DerivedMediaSnapshot {
  version: 1;
  generatorVersion: string;
  projectScope: DerivedProjectScope;
  assets: Record<string, DerivedAssetSnapshot>;
  storage: {
    totalBytes: number;
    budgetBytes: number;
    safetyReserveBytes: number;
    thumbnailBytes: number;
    filmstripBytes: number;
    waveformBytes: number;
    proxyBytes: number;
    evictionCount: number;
    lastEvictionReason?: string;
  };
  jobs: { queued: number; running: number; completed: number; failed: number };
  runtime: DerivedRuntimeSnapshot;
  decisionLog: DerivedMediaEvent[];
}

export interface BeginDerivedWrite {
  assetId: string;
  kind: DerivedArtifactKind;
  expectedBytes?: number;
  profileId?: string;
}

export interface FinalizeDerivedWrite {
  bytes: number;
  sourceTimeUs?: number;
  tileTimesUs?: number[];
  columns?: number;
  rows?: number;
  tileWidth?: number;
  tileHeight?: number;
  peakCount?: number;
  waveformFormatVersion?: number;
}

export interface DerivedPerformanceObservation {
  assetId: string;
  sourceKind: "original" | "proxy";
  operation: "sampling" | "hover-seek" | "playback";
  latencyMs?: number;
  deadlineMiss?: boolean;
  requestsReceived?: number;
  requestsCoalesced?: number;
  framesPresented?: number;
  framesObsolete?: number;
}

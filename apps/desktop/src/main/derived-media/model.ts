import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type {
  DerivedArtifactKind,
  DerivedArtifactSnapshot,
  DerivedAssetSnapshot,
  DerivedMediaEvent,
  DerivedMediaSnapshot,
  DerivedRuntimeSnapshot,
  SourceFingerprint,
  SourcePerformanceSnapshot,
} from "../../shared/api";

export const DERIVED_GENERATOR_VERSION = "4";
export const INDEX_FILE = join(".video", "cache", "media-intelligence.json");
export const MAX_WRITERS = 4;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_DECISION_EVENTS = 100;
export const MAX_RETIRED_WRITERS = 256;

export interface PersistedArtifact extends DerivedArtifactSnapshot {
  relativePath?: string;
  generatorVersion: string;
  sourceFingerprint: SourceFingerprint;
}

export interface PersistedAsset extends Omit<
  DerivedAssetSnapshot,
  "assetId" | "fingerprintStatus"
> {
  sourceFingerprint: SourceFingerprint;
  thumbnail: PersistedArtifact;
  filmstrip: PersistedArtifact;
  waveform: PersistedArtifact;
  proxy: PersistedArtifact;
}

export interface PersistedIndex {
  version: 1;
  generatorVersion: string;
  assets: Record<string, PersistedAsset>;
  storage: DerivedMediaSnapshot["storage"];
  decisionLog: DerivedMediaEvent[];
}

export interface PreparedDerivedProject {
  directory: string;
  index: PersistedIndex;
  readDurationMs: number;
}

export interface WriterSession {
  id: string;
  projectDirectory: string;
  assetId: string;
  kind: DerivedArtifactKind;
  profileId?: string;
  expectedBytes?: number;
  maxEnd: number;
  tempPath: string;
  finalPath: string;
  handle: FileHandle;
}

export function emptyPerformance(): SourcePerformanceSnapshot {
  return {
    observations: 0,
    requestsReceived: 0,
    requestsCoalesced: 0,
    framesPresented: 0,
    framesObsolete: 0,
  };
}

export function emptyRuntime(): DerivedRuntimeSnapshot {
  return {
    protocol: {
      requests: 0,
      rangeRequests: 0,
      bytesRead: 0,
      averageLatencyMs: 0,
      errors: 0,
    },
  };
}

export function emptyStorage(): DerivedMediaSnapshot["storage"] {
  return {
    totalBytes: 0,
    budgetBytes: 0,
    safetyReserveBytes: 0,
    thumbnailBytes: 0,
    filmstripBytes: 0,
    waveformBytes: 0,
    proxyBytes: 0,
    evictionCount: 0,
  };
}

export function emptyIndex(): PersistedIndex {
  return {
    version: 1,
    generatorVersion: DERIVED_GENERATOR_VERSION,
    assets: {},
    storage: emptyStorage(),
    decisionLog: [],
  };
}

export function projectOpenPersistenceSignature(index: PersistedIndex): string {
  return JSON.stringify({
    ...index,
    storage: {
      ...index.storage,
      // These values describe current filesystem capacity and are refreshed in memory on open.
      // Persisting only their fluctuations creates needless File Provider writes.
      budgetBytes: 0,
      safetyReserveBytes: 0,
    },
  });
}

export function artifactPath(
  kind: DerivedArtifactKind,
  assetId: string,
  profileId?: string,
): string {
  if (kind === "thumbnail") return join(".video", "thumbnails", `${assetId}.jpg`);
  if (kind === "filmstrip") return join(".video", "filmstrips", `${assetId}.jpg`);
  if (kind === "waveform") return join(".video", "waveforms", `${assetId}.cswf`);
  return join(".video", "proxies", `${assetId}-${profileId ?? "edit-720p"}.mp4`);
}

export function mimeType(kind: DerivedArtifactKind): string {
  if (kind === "proxy") return "video/mp4";
  if (kind === "waveform") return "application/vnd.cinesim.waveform";
  return "image/jpeg";
}

export function isAssetId(value: string): boolean {
  return /^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
}

export function validProfile(value: string | undefined): boolean {
  return value === undefined || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export function percentile(values: number[], ratio: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

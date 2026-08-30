import { lstat, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, Project } from "@cinesim/core";
import type { ProjectPaths } from "@cinesim/project-io";
import type {
  DerivedArtifactKind,
  DerivedMediaEvent,
  SourceFingerprint,
} from "../../shared/contracts";
import { fingerprintsEqual, fingerprintSource } from "./source-fingerprint";
import { DERIVED_GENERATOR_VERSION, emptyPerformance, mimeType } from "./model";
import type { PersistedArtifact, PersistedAsset, PersistedIndex } from "./model";

type DecisionLogger = (event: Omit<DerivedMediaEvent, "at">) => void;
type EvictionKind = "proxy" | "filmstrip" | "waveform";
type EvictionCandidate = {
  assetId: string;
  kind: EvictionKind;
  artifact: PersistedArtifact;
};

const EVICTION_KINDS: readonly EvictionKind[] = ["proxy", "filmstrip", "waveform"];
const EVICTION_PRIORITY: Record<EvictionKind, number> = { proxy: 0, filmstrip: 1, waveform: 2 };

async function sourceFingerprint(asset: Asset): Promise<SourceFingerprint> {
  if (asset.source.kind === "local") return fingerprintSource(asset.source.path);
  return { size: 0, mtimeMs: 0, edgeHash: asset.source.cloudAssetId };
}

function emptyAssetRecord(fingerprint: SourceFingerprint): PersistedAsset {
  const emptyArtifact = (): PersistedArtifact => ({
    state: "missing",
    generatorVersion: DERIVED_GENERATOR_VERSION,
    sourceFingerprint: fingerprint,
  });
  return {
    sourceFingerprint: fingerprint,
    thumbnail: emptyArtifact(),
    filmstrip: emptyArtifact(),
    waveform: emptyArtifact(),
    proxy: emptyArtifact(),
    performance: { original: emptyPerformance() },
  };
}

function artifactStorage(
  index: PersistedIndex,
): Omit<
  PersistedIndex["storage"],
  "budgetBytes" | "safetyReserveBytes" | "evictionCount" | "lastEvictionReason"
> {
  let thumbnailBytes = 0;
  let filmstripBytes = 0;
  let waveformBytes = 0;
  let proxyBytes = 0;
  for (const record of Object.values(index.assets)) {
    thumbnailBytes += record.thumbnail.bytes ?? 0;
    filmstripBytes += record.filmstrip.bytes ?? 0;
    waveformBytes += record.waveform.bytes ?? 0;
    proxyBytes += record.proxy.bytes ?? 0;
  }
  return {
    totalBytes: thumbnailBytes + filmstripBytes + waveformBytes + proxyBytes,
    thumbnailBytes,
    filmstripBytes,
    waveformBytes,
    proxyBytes,
  };
}

function evictionCandidates(index: PersistedIndex, project: Project): EvictionCandidate[] {
  return Object.entries(index.assets)
    .flatMap(([assetId, record]) =>
      EVICTION_KINDS.map((kind) => ({ assetId, kind, artifact: record[kind] })),
    )
    .filter((candidate) => isEvictable(candidate, project))
    .sort(compareEvictionCandidates);
}

function isEvictable(candidate: EvictionCandidate, project: Project): boolean {
  if (candidate.artifact.state !== "ready" || !candidate.artifact.relativePath) return false;
  if (candidate.kind !== "proxy") return true;
  const asset = project.assets.find(({ id }) => id === candidate.assetId);
  return asset?.source.kind !== "cloud";
}

function compareEvictionCandidates(left: EvictionCandidate, right: EvictionCandidate): number {
  if (left.kind !== right.kind) return EVICTION_PRIORITY[left.kind] - EVICTION_PRIORITY[right.kind];
  return (left.artifact.lastAccessAt ?? "").localeCompare(right.artifact.lastAccessAt ?? "");
}

export interface DerivedArtifactRepositoryOptions {
  diskSpace?: { capacityBytes: number; availableBytes: number };
}

export class DerivedArtifactRepository {
  #diskHeadroomAvailable = false;

  constructor(private readonly options: DerivedArtifactRepositoryOptions = {}) {}

  get diskHeadroomAvailable(): boolean {
    return this.#diskHeadroomAvailable;
  }

  async ensureAsset(
    paths: ProjectPaths,
    index: PersistedIndex,
    asset: Asset,
    log: DecisionLogger,
  ): Promise<PersistedAsset> {
    const current = index.assets[asset.id];
    if (asset.source.kind === "cloud" && current) return current;
    const fingerprint = await sourceFingerprint(asset);
    if (current && fingerprintsEqual(current.sourceFingerprint, fingerprint)) return current;
    if (current) {
      await this.removeRecordFiles(paths, current);
      log({
        assetId: asset.id,
        kind: "source-stale",
        detail: "Source fingerprint changed; derived artifacts invalidated",
      });
    }
    const record = emptyAssetRecord(fingerprint);
    index.assets[asset.id] = record;
    return record;
  }

  async refreshStorage(directory: string, index: PersistedIndex): Promise<void> {
    const fileSystem = this.options.diskSpace ? null : await statfs(directory);
    const capacity =
      this.options.diskSpace?.capacityBytes ?? fileSystem!.blocks * fileSystem!.bsize;
    const available =
      this.options.diskSpace?.availableBytes ?? fileSystem!.bavail * fileSystem!.bsize;
    const safetyReserveBytes = Math.max(2 * 1024 ** 3, Math.floor(capacity * 0.05));
    this.#diskHeadroomAvailable = available > safetyReserveBytes + 512 * 1024 ** 2;
    const budgetBytes = Math.max(
      256 * 1024 ** 2,
      Math.min(20 * 1024 ** 3, Math.floor(Math.max(0, available - safetyReserveBytes) * 0.25)),
    );
    index.storage = {
      ...index.storage,
      budgetBytes,
      safetyReserveBytes,
      ...artifactStorage(index),
    };
  }

  async removeInterruptedTemps(paths: ProjectPaths): Promise<void> {
    await Promise.all(
      ["thumbnails", "filmstrips", "waveforms", "proxies", "originals"].map(async (folder) => {
        const directory = paths.derived(join(".video", folder));
        const info = await lstat(directory).catch(() => null);
        if (!info?.isDirectory() || info.isSymbolicLink()) return;
        const names = await readdir(directory).catch(() => []);
        await Promise.all(
          names
            .filter((name) => name.endsWith(".tmp") && /^[a-zA-Z0-9_.-]+$/.test(name))
            .map((name) => rm(join(directory, name), { force: true })),
        );
      }),
    );
  }

  async removeAssets(
    paths: ProjectPaths,
    index: PersistedIndex,
    assetIds: readonly string[],
  ): Promise<void> {
    for (const assetId of assetIds) {
      const record = index.assets[assetId];
      if (record) {
        await this.removeRecordFiles(paths, record);
        delete index.assets[assetId];
      }
      await this.removeUnindexedAssetArtifacts(paths, assetId);
    }
  }

  async evict(
    paths: ProjectPaths,
    directory: string,
    index: PersistedIndex,
    project: Project,
    log: DecisionLogger,
  ): Promise<void> {
    if (index.storage.totalBytes <= index.storage.budgetBytes) return;
    for (const candidate of evictionCandidates(index, project)) {
      if (index.storage.totalBytes <= index.storage.budgetBytes) break;
      await rm(paths.derived(candidate.artifact.relativePath!), { force: true });
      index.storage.totalBytes -= candidate.artifact.bytes ?? 0;
      candidate.artifact.state = "missing";
      delete candidate.artifact.bytes;
      delete candidate.artifact.relativePath;
      delete candidate.artifact.progress;
      index.storage.evictionCount += 1;
      index.storage.lastEvictionReason = "project-budget-exceeded";
      log({
        assetId: candidate.assetId,
        kind: "artifact-evicted",
        detail: `${candidate.kind} evicted to stay within the automatic project budget`,
      });
    }
    await this.refreshStorage(directory, index);
  }

  async artifactFile(
    paths: ProjectPaths,
    index: PersistedIndex,
    kind: DerivedArtifactKind,
    assetId: string,
    profileId?: string,
    revision?: string,
  ): Promise<{ path: string; size: number; mimeType: string }> {
    const record = index.assets[assetId];
    if (!record) throw new Error("Derived asset is unavailable");
    const artifact = record[kind];
    if (artifact.state !== "ready" || !artifact.relativePath)
      throw new Error("Derived artifact is not ready");
    if (!revision || artifact.updatedAt !== revision)
      throw new Error("Unknown derived artifact revision");
    if (kind === "proxy" && profileId && artifact.profileId !== profileId)
      throw new Error("Unknown proxy profile");
    const path = paths.derived(artifact.relativePath);
    const info = await stat(path);
    artifact.lastAccessAt = new Date().toISOString();
    return { path, size: info.size, mimeType: mimeType(kind) };
  }

  private async removeRecordFiles(paths: ProjectPaths, record: PersistedAsset): Promise<void> {
    await Promise.all(
      [record.thumbnail, record.filmstrip, record.waveform, record.proxy].map((artifact) =>
        artifact.relativePath
          ? rm(paths.derived(artifact.relativePath), { force: true }).catch(() => undefined)
          : Promise.resolve(),
      ),
    );
  }

  private async removeUnindexedAssetArtifacts(paths: ProjectPaths, assetId: string): Promise<void> {
    const candidates = [
      { folder: "thumbnails", matches: (name: string) => name === `${assetId}.jpg` },
      { folder: "filmstrips", matches: (name: string) => name === `${assetId}.jpg` },
      { folder: "waveforms", matches: (name: string) => name === `${assetId}.cswf` },
      {
        folder: "proxies",
        matches: (name: string) => name.startsWith(`${assetId}-`) && name.endsWith(".mp4"),
      },
      {
        folder: "frames",
        matches: (name: string) => name.startsWith(`${assetId}-`) && name.endsWith(".png"),
      },
      { folder: "originals", matches: (name: string) => name === assetId },
    ];
    await Promise.all(
      candidates.map(async ({ folder, matches }) => {
        const directory = paths.derived(join(".video", folder));
        const info = await lstat(directory).catch(() => null);
        if (!info?.isDirectory() || info.isSymbolicLink()) return;
        const names = await readdir(directory).catch(() => []);
        await Promise.all(
          names
            .filter((name) => matches(name) && /^[a-zA-Z0-9_.-]+$/.test(name))
            .map((name) => rm(join(directory, name), { force: true })),
        );
      }),
    );
  }
}

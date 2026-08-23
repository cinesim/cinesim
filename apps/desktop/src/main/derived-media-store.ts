import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Asset, Project } from "@cinesim/core";
import type {
  BeginDerivedWrite,
  DerivedArtifactKind,
  DerivedArtifactSnapshot,
  DerivedAssetSnapshot,
  DerivedMediaEvent,
  DerivedMediaSnapshot,
  DerivedPerformanceObservation,
  FinalizeDerivedWrite,
  SourceFingerprint,
  SourcePerformanceSnapshot,
} from "../shared/api";

const GENERATOR_VERSION = "1";
const INDEX_FILE = join(".video", "cache", "media-intelligence.json");
const MAX_WRITERS = 4;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const EDGE_BYTES = 64 * 1024;
const MAX_DECISION_EVENTS = 100;

interface PersistedArtifact extends DerivedArtifactSnapshot {
  relativePath?: string;
  generatorVersion: string;
  sourceFingerprint: SourceFingerprint;
}

interface PersistedAsset extends Omit<DerivedAssetSnapshot, "assetId" | "fingerprintStatus"> {
  sourceFingerprint: SourceFingerprint;
  thumbnail: PersistedArtifact;
  filmstrip: PersistedArtifact;
  proxy: PersistedArtifact;
}

interface PersistedIndex {
  version: 1;
  generatorVersion: string;
  assets: Record<string, PersistedAsset>;
  storage: DerivedMediaSnapshot["storage"];
  decisionLog: DerivedMediaEvent[];
}

interface WriterSession {
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

function emptyPerformance(): SourcePerformanceSnapshot {
  return {
    observations: 0,
    requestsReceived: 0,
    requestsCoalesced: 0,
    framesPresented: 0,
    framesObsolete: 0,
  };
}

function emptyStorage(): DerivedMediaSnapshot["storage"] {
  return {
    totalBytes: 0,
    budgetBytes: 0,
    safetyReserveBytes: 0,
    thumbnailBytes: 0,
    filmstripBytes: 0,
    proxyBytes: 0,
    evictionCount: 0,
  };
}

function emptyIndex(): PersistedIndex {
  return {
    version: 1,
    generatorVersion: GENERATOR_VERSION,
    assets: {},
    storage: emptyStorage(),
    decisionLog: [],
  };
}

function artifactPath(kind: DerivedArtifactKind, assetId: string, profileId?: string): string {
  if (kind === "thumbnail") return join(".video", "thumbnails", `${assetId}.jpg`);
  if (kind === "filmstrip") return join(".video", "filmstrips", `${assetId}.jpg`);
  return join(".video", "proxies", `${assetId}-${profileId ?? "edit-720p"}.mp4`);
}

function mimeType(kind: DerivedArtifactKind): string {
  return kind === "proxy" ? "video/mp4" : "image/jpeg";
}

function isAssetId(value: string): boolean {
  return /^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
}

function validProfile(value: string | undefined): boolean {
  return value === undefined || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function percentile(values: number[], ratio: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

export class DerivedMediaStore {
  #directory: string | null = null;
  #project: Project | null = null;
  #index: PersistedIndex = emptyIndex();
  #writers = new Map<string, WriterSession>();
  #listeners = new Set<(snapshot: DerivedMediaSnapshot) => void>();
  #operationQueue: Promise<unknown> = Promise.resolve();
  #latencies = new Map<string, number[]>();

  async setProject(directory: string, project: Project): Promise<void> {
    await this.#serialize(async () => {
      await this.#closeWriters();
      this.#directory = directory;
      this.#project = project;
      this.#latencies.clear();
      this.#index = await this.#readIndex(directory);
      let recovered = false;
      for (const record of Object.values(this.#index.assets)) {
        for (const artifact of [record.thumbnail, record.filmstrip, record.proxy]) {
          if (artifact.state === "running") {
            artifact.state = "queued";
            artifact.progress = 0;
            recovered = true;
          }
        }
      }
      for (const asset of project.assets) await this.#ensureAsset(asset);
      await this.#refreshStorage();
      if (recovered)
        this.#log({ kind: "jobs-recovered", detail: "Interrupted jobs returned to the queue" });
      await this.#persist();
      this.#emit();
    });
  }

  updateProject(project: Project): void {
    this.#project = project;
  }

  subscribe(listener: (snapshot: DerivedMediaSnapshot) => void): () => void {
    this.#listeners.add(listener);
    if (this.#directory) listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  snapshot(): DerivedMediaSnapshot {
    const project = this.#requireProject();
    const assets: Record<string, DerivedAssetSnapshot> = {};
    for (const asset of project.assets) {
      const record = this.#index.assets[asset.id];
      if (!record) continue;
      assets[asset.id] = {
        assetId: asset.id,
        fingerprintStatus: record.sourceFingerprint.size < 0 ? "missing" : "current",
        thumbnail: this.#publicArtifact(record.thumbnail),
        filmstrip: this.#publicArtifact(record.filmstrip),
        proxy: this.#publicArtifact(record.proxy),
        performance: structuredClone(record.performance),
      };
    }
    const artifacts = Object.values(assets).flatMap((asset) => [
      asset.thumbnail,
      asset.filmstrip,
      asset.proxy,
    ]);
    return {
      version: 1,
      generatorVersion: GENERATOR_VERSION,
      assets,
      storage: structuredClone(this.#index.storage),
      jobs: {
        queued: artifacts.filter((artifact) => artifact.state === "queued").length,
        running: artifacts.filter((artifact) => artifact.state === "running").length,
        completed: artifacts.filter((artifact) => artifact.state === "ready").length,
        failed: artifacts.filter((artifact) => artifact.state === "failed").length,
      },
      decisionLog: structuredClone(this.#index.decisionLog),
    };
  }

  async requestJobs(assetIds: string[]): Promise<DerivedMediaSnapshot> {
    return this.#serialize(async () => {
      if (assetIds.length > 500) throw new Error("Too many derived job requests");
      const project = this.#requireProject();
      for (const assetId of new Set(assetIds)) {
        const asset = project.assets.find((candidate) => candidate.id === assetId);
        if (!asset || asset.kind !== "video") continue;
        const record = await this.#ensureAsset(asset);
        for (const kind of ["thumbnail", "filmstrip"] as const) {
          const artifact = record[kind];
          if (artifact.state === "missing" || artifact.state === "failed")
            artifact.state = "queued";
        }
      }
      await this.#persist();
      this.#emit();
      return this.snapshot();
    });
  }

  async beginWrite(input: BeginDerivedWrite): Promise<{ writerId: string }> {
    return this.#serialize(async () => {
      this.#validateWriteInput(input);
      if (this.#writers.size >= MAX_WRITERS) throw new Error("Too many derived writers");
      const directory = this.#requireDirectory();
      const asset = this.#requireAsset(input.assetId);
      const record = await this.#ensureAsset(asset);
      const id = randomUUID();
      const relativePath = artifactPath(input.kind, input.assetId, input.profileId);
      const finalPath = this.#containedPath(relativePath);
      const tempPath = `${finalPath}.${id}.tmp`;
      await mkdir(dirname(finalPath), { recursive: true });
      const handle = await open(tempPath, "wx+");
      this.#writers.set(id, {
        id,
        projectDirectory: directory,
        assetId: input.assetId,
        kind: input.kind,
        ...(input.profileId ? { profileId: input.profileId } : {}),
        ...(input.expectedBytes ? { expectedBytes: input.expectedBytes } : {}),
        maxEnd: 0,
        tempPath,
        finalPath,
        handle,
      });
      const artifact = record[input.kind];
      artifact.state = "running";
      artifact.progress = 0;
      delete artifact.failureCode;
      artifact.updatedAt = new Date().toISOString();
      await this.#persist();
      this.#emit();
      return { writerId: id };
    });
  }

  async writeChunk(writerId: string, offset: number, data: Uint8Array): Promise<void> {
    await this.#serialize(async () => {
      if (
        !(data instanceof Uint8Array) ||
        data.byteLength === 0 ||
        data.byteLength > MAX_CHUNK_BYTES
      )
        throw new Error("Invalid derived chunk");
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid derived offset");
      const writer = this.#requireWriter(writerId);
      const end = offset + data.byteLength;
      if (end > MAX_ARTIFACT_BYTES || (writer.expectedBytes && end > writer.expectedBytes))
        throw new Error("Derived artifact exceeds its bound");
      await writer.handle.write(data, 0, data.byteLength, offset);
      writer.maxEnd = Math.max(writer.maxEnd, end);
      const record = this.#index.assets[writer.assetId]!;
      if (writer.expectedBytes)
        record[writer.kind].progress = Math.min(0.99, writer.maxEnd / writer.expectedBytes);
      this.#emit();
    });
  }

  async finalizeWrite(writerId: string, result: FinalizeDerivedWrite): Promise<void> {
    await this.#serialize(async () => {
      const writer = this.#requireWriter(writerId);
      if (
        !Number.isSafeInteger(result.bytes) ||
        result.bytes <= 0 ||
        result.bytes !== writer.maxEnd
      )
        throw new Error("Derived artifact size does not match written data");
      if (writer.expectedBytes && result.bytes !== writer.expectedBytes)
        throw new Error("Derived artifact does not match expected size");
      this.#validateFinalize(result);
      await writer.handle.sync();
      await writer.handle.close();
      await rename(writer.tempPath, writer.finalPath);
      this.#writers.delete(writer.id);
      const record = this.#index.assets[writer.assetId]!;
      const artifact = record[writer.kind];
      artifact.state = "ready";
      artifact.relativePath = relative(this.#requireDirectory(), writer.finalPath);
      artifact.bytes = result.bytes;
      artifact.progress = 1;
      artifact.updatedAt = new Date().toISOString();
      artifact.lastAccessAt = artifact.updatedAt;
      if (writer.profileId) artifact.profileId = writer.profileId;
      if (result.sourceTimeUs !== undefined) artifact.sourceTimeUs = result.sourceTimeUs;
      if (result.tileTimesUs) artifact.tileTimesUs = result.tileTimesUs;
      if (result.columns !== undefined) artifact.columns = result.columns;
      if (result.rows !== undefined) artifact.rows = result.rows;
      if (result.tileWidth !== undefined) artifact.tileWidth = result.tileWidth;
      if (result.tileHeight !== undefined) artifact.tileHeight = result.tileHeight;
      this.#log({
        assetId: writer.assetId,
        kind: `${writer.kind}-ready`,
        detail: `${writer.kind} generated (${result.bytes} bytes)`,
      });
      await this.#refreshStorage();
      await this.#evictIfNeeded();
      await this.#persist();
      this.#emit();
    });
  }

  async cancelWrite(writerId: string, failureCode?: string): Promise<void> {
    await this.#serialize(async () => {
      const writer = this.#requireWriter(writerId);
      await writer.handle.close().catch(() => undefined);
      await rm(writer.tempPath, { force: true });
      this.#writers.delete(writer.id);
      const artifact = this.#index.assets[writer.assetId]![writer.kind];
      artifact.state = failureCode ? "failed" : "queued";
      artifact.progress = 0;
      if (failureCode) artifact.failureCode = failureCode;
      else delete artifact.failureCode;
      artifact.updatedAt = new Date().toISOString();
      await this.#persist();
      this.#emit();
    });
  }

  async reportPerformance(observation: DerivedPerformanceObservation): Promise<void> {
    await this.#serialize(async () => {
      const asset = this.#requireAsset(observation.assetId);
      const record = await this.#ensureAsset(asset);
      const summary =
        observation.sourceKind === "proxy"
          ? (record.performance.proxy ??= emptyPerformance())
          : record.performance.original;
      summary.observations += 1;
      summary.requestsReceived += observation.requestsReceived ?? 0;
      summary.requestsCoalesced += observation.requestsCoalesced ?? 0;
      summary.framesPresented += observation.framesPresented ?? 0;
      summary.framesObsolete += observation.framesObsolete ?? 0;
      if (observation.latencyMs !== undefined) {
        if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0)
          throw new Error("Invalid media latency");
        const key = `${observation.assetId}:${observation.sourceKind}`;
        const values = this.#latencies.get(key) ?? [];
        values.push(observation.latencyMs);
        if (values.length > 64) values.shift();
        this.#latencies.set(key, values);
        summary.warmSeekP50Ms = percentile(values, 0.5)!;
        summary.warmSeekP95Ms = percentile(values, 0.95)!;
      }
      await this.#persist();
      this.#emit();
    });
  }

  async readArtifactRange(
    kind: DerivedArtifactKind,
    assetId: string,
    start: number,
    endExclusive: number,
    profileId?: string,
  ): Promise<{ data: Buffer; size: number; mimeType: string }> {
    const asset = this.#requireAsset(assetId);
    const record = await this.#ensureAsset(asset);
    const artifact = record[kind];
    if (artifact.state !== "ready" || !artifact.relativePath)
      throw new Error("Derived artifact is not ready");
    if (kind === "proxy" && profileId && artifact.profileId !== profileId)
      throw new Error("Unknown proxy profile");
    const path = this.#containedPath(artifact.relativePath);
    const info = await stat(path);
    const safeStart = Math.max(0, Math.min(start, info.size));
    const safeEnd = Math.max(
      safeStart,
      Math.min(endExclusive, info.size, safeStart + 16 * 1024 * 1024),
    );
    const handle = await open(path, "r");
    try {
      const data = Buffer.alloc(safeEnd - safeStart);
      await handle.read(data, 0, data.byteLength, safeStart);
      artifact.lastAccessAt = new Date().toISOString();
      void this.#persist();
      return { data, size: info.size, mimeType: mimeType(kind) };
    } finally {
      await handle.close();
    }
  }

  async #ensureAsset(asset: Asset): Promise<PersistedAsset> {
    const fingerprint = await this.#fingerprint(asset.source.path);
    const current = this.#index.assets[asset.id];
    if (current && this.#fingerprintsEqual(current.sourceFingerprint, fingerprint)) return current;
    if (current) {
      for (const artifact of [current.thumbnail, current.filmstrip, current.proxy]) {
        if (artifact.relativePath)
          await rm(this.#containedPath(artifact.relativePath), { force: true }).catch(
            () => undefined,
          );
      }
      this.#log({
        assetId: asset.id,
        kind: "source-stale",
        detail: "Source fingerprint changed; derived artifacts invalidated",
      });
    }
    const emptyArtifact = (): PersistedArtifact => ({
      state: "missing",
      generatorVersion: GENERATOR_VERSION,
      sourceFingerprint: fingerprint,
    });
    const record: PersistedAsset = {
      sourceFingerprint: fingerprint,
      thumbnail: emptyArtifact(),
      filmstrip: emptyArtifact(),
      proxy: emptyArtifact(),
      performance: { original: emptyPerformance(), decision: "observing", reasons: [] },
    };
    this.#index.assets[asset.id] = record;
    return record;
  }

  async #fingerprint(path: string): Promise<SourceFingerprint> {
    const info = await stat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!info) return { size: -1, mtimeMs: -1, edgeHash: "missing" };
    const handle = await open(path, "r");
    try {
      const firstSize = Math.min(EDGE_BYTES, info.size);
      const lastSize = Math.min(EDGE_BYTES, Math.max(0, info.size - firstSize));
      const first = Buffer.alloc(firstSize);
      const last = Buffer.alloc(lastSize);
      if (firstSize) await handle.read(first, 0, firstSize, 0);
      if (lastSize) await handle.read(last, 0, lastSize, info.size - lastSize);
      const edgeHash = createHash("sha256").update(first).update(last).digest("hex");
      return { size: info.size, mtimeMs: info.mtimeMs, edgeHash };
    } finally {
      await handle.close();
    }
  }

  #fingerprintsEqual(left: SourceFingerprint, right: SourceFingerprint): boolean {
    return (
      left.size === right.size && left.mtimeMs === right.mtimeMs && left.edgeHash === right.edgeHash
    );
  }

  async #readIndex(directory: string): Promise<PersistedIndex> {
    try {
      const value = JSON.parse(
        await readFile(join(directory, INDEX_FILE), "utf8"),
      ) as PersistedIndex;
      if (value.version !== 1 || value.generatorVersion !== GENERATOR_VERSION) return emptyIndex();
      value.decisionLog = Array.isArray(value.decisionLog)
        ? value.decisionLog.slice(-MAX_DECISION_EVENTS)
        : [];
      value.storage = { ...emptyStorage(), ...value.storage };
      return value;
    } catch {
      return emptyIndex();
    }
  }

  async #refreshStorage(): Promise<void> {
    const directory = this.#requireDirectory();
    const fileSystem = await statfs(directory);
    const capacity = fileSystem.blocks * fileSystem.bsize;
    const available = fileSystem.bavail * fileSystem.bsize;
    const safetyReserveBytes = Math.max(2 * 1024 ** 3, Math.floor(capacity * 0.05));
    const budgetBytes = Math.max(
      256 * 1024 ** 2,
      Math.min(20 * 1024 ** 3, Math.floor(Math.max(0, available - safetyReserveBytes) * 0.25)),
    );
    let thumbnailBytes = 0;
    let filmstripBytes = 0;
    let proxyBytes = 0;
    for (const record of Object.values(this.#index.assets)) {
      thumbnailBytes += record.thumbnail.bytes ?? 0;
      filmstripBytes += record.filmstrip.bytes ?? 0;
      proxyBytes += record.proxy.bytes ?? 0;
    }
    this.#index.storage = {
      ...this.#index.storage,
      totalBytes: thumbnailBytes + filmstripBytes + proxyBytes,
      budgetBytes,
      safetyReserveBytes,
      thumbnailBytes,
      filmstripBytes,
      proxyBytes,
    };
  }

  async #evictIfNeeded(): Promise<void> {
    const storage = this.#index.storage;
    if (storage.totalBytes <= storage.budgetBytes) return;
    const candidates = Object.entries(this.#index.assets)
      .flatMap(([assetId, record]) =>
        (["proxy", "filmstrip"] as const).map((kind) => ({
          assetId,
          kind,
          artifact: record[kind],
        })),
      )
      .filter(
        (candidate) => candidate.artifact.state === "ready" && candidate.artifact.relativePath,
      )
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "proxy" ? -1 : 1;
        return (left.artifact.lastAccessAt ?? "").localeCompare(right.artifact.lastAccessAt ?? "");
      });
    for (const candidate of candidates) {
      if (this.#index.storage.totalBytes <= this.#index.storage.budgetBytes) break;
      await rm(this.#containedPath(candidate.artifact.relativePath!), { force: true });
      this.#index.storage.totalBytes -= candidate.artifact.bytes ?? 0;
      candidate.artifact.state = "missing";
      delete candidate.artifact.bytes;
      delete candidate.artifact.relativePath;
      delete candidate.artifact.progress;
      this.#index.storage.evictionCount += 1;
      this.#index.storage.lastEvictionReason = "project-budget-exceeded";
      this.#log({
        assetId: candidate.assetId,
        kind: "artifact-evicted",
        detail: `${candidate.kind} evicted to stay within the automatic project budget`,
      });
    }
    await this.#refreshStorage();
  }

  #validateWriteInput(input: BeginDerivedWrite): void {
    if (!isAssetId(input.assetId)) throw new Error("Invalid asset ID");
    if (!["thumbnail", "filmstrip", "proxy"].includes(input.kind))
      throw new Error("Invalid derived artifact kind");
    if (!validProfile(input.profileId)) throw new Error("Invalid proxy profile");
    if (input.kind !== "proxy" && input.profileId)
      throw new Error("Profiles are only valid for proxies");
    if (
      input.expectedBytes !== undefined &&
      (!Number.isSafeInteger(input.expectedBytes) ||
        input.expectedBytes <= 0 ||
        input.expectedBytes > MAX_ARTIFACT_BYTES)
    )
      throw new Error("Invalid expected derived size");
  }

  #validateFinalize(result: FinalizeDerivedWrite): void {
    for (const value of [
      result.sourceTimeUs,
      result.columns,
      result.rows,
      result.tileWidth,
      result.tileHeight,
    ]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error("Invalid derived metadata");
    }
    if (
      result.tileTimesUs &&
      (result.tileTimesUs.length > 64 ||
        result.tileTimesUs.some((value) => !Number.isSafeInteger(value) || value < 0))
    )
      throw new Error("Invalid filmstrip times");
  }

  #containedPath(relativePath: string): string {
    const root = resolve(this.#requireDirectory(), ".video");
    const path = resolve(this.#requireDirectory(), relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Unsafe derived path");
    return path;
  }

  #requireWriter(id: string): WriterSession {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid derived writer ID");
    const writer = this.#writers.get(id);
    if (!writer || writer.projectDirectory !== this.#requireDirectory())
      throw new Error("Unknown derived writer");
    return writer;
  }

  #requireAsset(assetId: string): Asset {
    if (!isAssetId(assetId)) throw new Error("Invalid asset ID");
    const asset = this.#requireProject().assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error("Unknown asset");
    return asset;
  }

  #requireDirectory(): string {
    if (!this.#directory) throw new Error("No project is open");
    return this.#directory;
  }

  #requireProject(): Project {
    if (!this.#project) throw new Error("No project is open");
    return this.#project;
  }

  #publicArtifact(artifact: PersistedArtifact): DerivedArtifactSnapshot {
    const {
      relativePath: _relativePath,
      generatorVersion: _version,
      sourceFingerprint: _fingerprint,
      ...value
    } = artifact;
    return structuredClone(value);
  }

  #log(event: Omit<DerivedMediaEvent, "at">): void {
    this.#index.decisionLog.push({ ...event, at: new Date().toISOString() });
    if (this.#index.decisionLog.length > MAX_DECISION_EVENTS)
      this.#index.decisionLog.splice(0, this.#index.decisionLog.length - MAX_DECISION_EVENTS);
  }

  async #persist(): Promise<void> {
    const path = join(this.#requireDirectory(), INDEX_FILE);
    const tempPath = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(this.#index, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  #emit(): void {
    if (!this.#directory) return;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  async #closeWriters(): Promise<void> {
    await Promise.all(
      [...this.#writers.values()].map(async (writer) => {
        await writer.handle.close().catch(() => undefined);
        await rm(writer.tempPath, { force: true });
      }),
    );
    this.#writers.clear();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.catch(() => undefined).then(operation);
    this.#operationQueue = result;
    return result;
  }
}

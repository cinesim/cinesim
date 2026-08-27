import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_SETTINGS } from "@cinesim/core";
import type { Asset, Project, ProjectSettings } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import type {
  BeginDerivedWrite,
  DerivedArtifactKind,
  DerivedArtifactSnapshot,
  DerivedAssetSnapshot,
  DerivedMediaEvent,
  DerivedProjectScope,
  DerivedMediaSnapshot,
  DerivedPerformanceObservation,
  DerivedWorkerActivity,
  FinalizeDerivedWrite,
} from "../../shared/api";
import {
  decodeWaveformEnvelope,
  waveformByteLength,
  waveformPeakCount,
} from "../../shared/waveform-format";
import {
  validateFinalize,
  validateWriteInput,
  validFilmstripMetadata,
} from "./artifact-validation";
import { DerivedIndexRepository } from "./index-repository";
import {
  artifactPath,
  DERIVED_GENERATOR_VERSION,
  emptyIndex,
  emptyPerformance,
  isAssetId,
  MAX_ARTIFACT_BYTES,
  MAX_CHUNK_BYTES,
  MAX_DECISION_EVENTS,
  MAX_RETIRED_WRITERS,
  MAX_WRITERS,
  mimeType,
  percentile,
  projectOpenPersistenceSignature,
} from "./model";
import type {
  PersistedArtifact,
  PersistedAsset,
  PersistedIndex,
  PreparedDerivedProject,
  WriterSession,
} from "./model";

export { DERIVED_GENERATOR_VERSION } from "./model";
import { fingerprintsEqual, fingerprintSource } from "./source-fingerprint";
import { DerivedRuntimeTracker } from "./runtime-tracker";

const log = createCinesimLogger({ service: "derived-media" });

interface DerivedMediaStoreOptions {
  diskSpace?: { capacityBytes: number; availableBytes: number };
}

export class DerivedMediaStore {
  #directory: string | null = null;
  #scope: DerivedProjectScope | null = null;
  #project: Project | null = null;
  #settings: ProjectSettings = DEFAULT_SETTINGS;
  #index: PersistedIndex = emptyIndex();
  #writers = new Map<string, WriterSession>();
  #retiredWriters = new Set<string>();
  #listeners = new Set<(snapshot: DerivedMediaSnapshot) => void>();
  #operationQueue: Promise<unknown> = Promise.resolve();
  #indexRepository = new DerivedIndexRepository();
  #latencies = new Map<string, number[]>();
  #deadlines = new Map<string, { total: number; missed: number }>();
  #progressLogBuckets = new Map<string, number>();
  #removedAssetIds = new Set<string>();
  #diskHeadroomAvailable = false;
  #runtimeTracker = new DerivedRuntimeTracker(
    () => this.#emit(),
    () => this.#scope,
  );

  constructor(private readonly options: DerivedMediaStoreOptions = {}) {}

  async prepareProject(directory: string): Promise<PreparedDerivedProject> {
    const startedAt = performance.now();
    const index = await this.#indexRepository.read(directory);
    return { directory, index, readDurationMs: performance.now() - startedAt };
  }

  async setProject(
    directory: string,
    project: Project,
    prepared?: PreparedDerivedProject,
    settings: ProjectSettings = DEFAULT_SETTINGS,
  ): Promise<void> {
    const canonicalDirectory = await realpath(directory);
    await this.#serialize(async () => {
      // A prepared index is safe for a different, inactive project. Reopening the active
      // directory must read again after queued writer operations have finished.
      const usePreparedIndex = prepared?.directory === directory && this.#directory !== directory;
      await this.#closeWriters();
      this.#directory = directory;
      this.#scope = {
        cacheKey: createHash("sha256").update(canonicalDirectory).digest("hex").slice(0, 24),
        epoch: randomUUID(),
      };
      this.#project = project;
      this.#settings = structuredClone(settings);
      this.#latencies.clear();
      this.#deadlines.clear();
      this.#runtimeTracker.reset();
      this.#progressLogBuckets.clear();
      this.#removedAssetIds.clear();
      this.#index = usePreparedIndex ? prepared.index : await this.#indexRepository.read(directory);
      const persistenceSignature = projectOpenPersistenceSignature(this.#index);
      await this.#removeInterruptedTemps();
      await this.#pruneRemovedAssetsNow();
      let recovered = false;
      let invalidatedFilmstripMetadata = false;
      for (const record of Object.values(this.#index.assets)) {
        for (const artifact of [
          record.thumbnail,
          record.filmstrip,
          record.waveform,
          record.proxy,
        ]) {
          if (artifact.state === "running") {
            artifact.state = "queued";
            artifact.progress = 0;
            recovered = true;
          }
        }
        if (record.filmstrip.state === "ready" && !validFilmstripMetadata(record.filmstrip)) {
          if (record.filmstrip.relativePath)
            await rm(this.#containedPath(record.filmstrip.relativePath), { force: true }).catch(
              () => undefined,
            );
          record.filmstrip.state = "missing";
          delete record.filmstrip.relativePath;
          delete record.filmstrip.bytes;
          invalidatedFilmstripMetadata = true;
        }
      }
      await Promise.all(project.assets.map((asset) => this.#ensureAsset(asset)));
      await this.#refreshStorage();
      for (const asset of project.assets)
        if (this.#settings.proxyGeneration === "automatic" || asset.source.kind === "cloud")
          await this.#queueProxyRecord(asset);
      if (recovered)
        this.#log({ kind: "jobs-recovered", detail: "Interrupted jobs returned to the queue" });
      if (recovered)
        log.warn(
          { operation: "project-open", projectId: project.id },
          "interrupted derived jobs returned to the queue",
        );
      if (invalidatedFilmstripMetadata)
        this.#log({
          kind: "filmstrip-metadata-invalidated",
          detail: "An inconsistent filmstrip was removed and will be regenerated",
        });
      const indexChanged = projectOpenPersistenceSignature(this.#index) !== persistenceSignature;
      if (indexChanged) await this.#persist();
      this.#emit();
      log.info(
        {
          operation: "project-open-derived",
          projectId: project.id,
          projectCacheKey: this.#scope.cacheKey,
          projectEpoch: this.#scope.epoch,
          indexReadMs: usePreparedIndex ? prepared.readDurationMs : undefined,
          assetCount: project.assets.length,
          indexChanged,
        },
        "derived media initialized for project",
      );
    });
  }

  updateProject(project: Project): void {
    const retained = new Set<string>(project.assets.map((asset) => asset.id));
    for (const asset of this.#project?.assets ?? []) {
      if (!retained.has(asset.id)) this.#removedAssetIds.add(asset.id);
    }
    for (const asset of project.assets) this.#removedAssetIds.delete(asset.id);
    this.#project = project;
  }

  async updateSettings(settings: ProjectSettings): Promise<void> {
    await this.#serialize(async () => {
      this.#settings = structuredClone(settings);
      const project = this.#requireProject();
      for (const asset of project.assets)
        if (settings.proxyGeneration === "automatic" || asset.source.kind === "cloud")
          await this.#queueProxyRecord(asset);
      if (settings.proxyGeneration === "manual")
        for (const [assetId, record] of Object.entries(this.#index.assets))
          if (
            record.proxy.state === "queued" &&
            project.assets.find((asset) => asset.id === assetId)?.source.kind !== "cloud"
          ) {
            record.proxy.state = "missing";
            delete record.proxy.progress;
          }
      await this.#persist();
      this.#emit();
    });
  }

  async pruneRemovedAssets(): Promise<void> {
    await this.#serialize(() => this.#pruneRemovedAssetsNow());
  }

  async clearProject(): Promise<void> {
    await this.#serialize(async () => {
      await this.#closeWriters();
      this.#directory = null;
      this.#scope = null;
      this.#project = null;
      this.#settings = DEFAULT_SETTINGS;
      this.#index = emptyIndex();
      this.#latencies.clear();
      this.#deadlines.clear();
      this.#progressLogBuckets.clear();
      this.#removedAssetIds.clear();
      this.#runtimeTracker.reset();
    });
  }

  scope(): DerivedProjectScope {
    return structuredClone(this.#requireScope());
  }

  assertScope(scope: DerivedProjectScope): void {
    if (!this.#scopeMatches(scope)) throw new Error("Stale derived media project scope");
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
        waveform: this.#publicArtifact(record.waveform),
        proxy: this.#publicArtifact(record.proxy),
        performance: structuredClone(record.performance),
      };
    }
    const artifacts = Object.values(assets).flatMap((asset) => [
      asset.thumbnail,
      asset.filmstrip,
      asset.waveform,
      asset.proxy,
    ]);
    return {
      version: 1,
      generatorVersion: DERIVED_GENERATOR_VERSION,
      projectScope: this.scope(),
      assets,
      storage: structuredClone(this.#index.storage),
      jobs: {
        queued: artifacts.filter((artifact) => artifact.state === "queued").length,
        running: artifacts.filter((artifact) => artifact.state === "running").length,
        completed: artifacts.filter((artifact) => artifact.state === "ready").length,
        failed: artifacts.filter((artifact) => artifact.state === "failed").length,
      },
      runtime: this.#runtimeTracker.snapshot(),
      decisionLog: structuredClone(this.#index.decisionLog),
    };
  }

  async requestJobs(scope: DerivedProjectScope, assetIds: string[]): Promise<DerivedMediaSnapshot> {
    return this.#serialize(async () => {
      this.assertScope(scope);
      if (assetIds.length > 500) throw new Error("Too many derived job requests");
      const persistenceSignature = projectOpenPersistenceSignature(this.#index);
      const project = this.#requireProject();
      for (const assetId of new Set(assetIds)) {
        const asset = project.assets.find((candidate) => candidate.id === assetId);
        if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) continue;
        const record = await this.#ensureAsset(asset);
        const kinds: DerivedArtifactKind[] = [];
        if (asset.kind === "video") kinds.push("thumbnail", "filmstrip");
        if (asset.kind === "audio" || asset.hasAudio === true) kinds.push("waveform");
        for (const kind of kinds) {
          const artifact = record[kind];
          if (artifact.state === "missing") artifact.state = "queued";
        }
        if (this.#settings.proxyGeneration === "automatic" || asset.source.kind === "cloud")
          await this.#queueProxyRecord(asset);
      }
      if (projectOpenPersistenceSignature(this.#index) !== persistenceSignature)
        await this.#persist();
      this.#emit();
      return this.snapshot();
    });
  }

  async queueProxy(assetId: string): Promise<DerivedMediaSnapshot> {
    return this.#serialize(async () => {
      const asset = this.#requireAsset(assetId);
      if (asset.kind !== "video" && asset.kind !== "audio")
        throw new Error("This media type does not support edit proxies yet");
      await this.#queueProxyRecord(asset, true);
      await this.#persist();
      this.#emit();
      return this.snapshot();
    });
  }

  async queueProxies(
    scope: DerivedProjectScope,
    assetIds: string[],
  ): Promise<DerivedMediaSnapshot> {
    this.assertScope(scope);
    if (assetIds.length === 0 || assetIds.length > 100)
      throw new Error("Invalid proxy job request");
    for (const assetId of new Set(assetIds)) await this.queueProxy(assetId);
    return this.snapshot();
  }

  async waitForProxy(assetId: string, signal?: AbortSignal): Promise<void> {
    const current = this.snapshot().assets[assetId]?.proxy;
    if (current?.state === "ready") return;
    if (current?.state === "failed") throw new Error("The edit proxy could not be generated");
    await new Promise<void>((resolve, reject) => {
      const stop = this.subscribe((snapshot) => {
        const proxy = snapshot.assets[assetId]?.proxy;
        if (proxy?.state === "ready") {
          stop();
          signal?.removeEventListener("abort", abort);
          resolve();
        } else if (proxy?.state === "failed") {
          stop();
          signal?.removeEventListener("abort", abort);
          reject(new Error("The edit proxy could not be generated"));
        }
      });
      const abort = () => {
        stop();
        reject(new Error("Cloud transfer canceled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async beginWrite(
    scope: DerivedProjectScope,
    input: BeginDerivedWrite,
  ): Promise<{ writerId: string }> {
    return this.#serialize(async () => {
      this.assertScope(scope);
      validateWriteInput(input);
      if (input.kind === "proxy" && !this.#diskHeadroomAvailable)
        throw new Error("Insufficient disk headroom for a proxy");
      if (this.#writers.size >= MAX_WRITERS) throw new Error("Too many derived writers");
      const directory = this.#requireDirectory();
      const asset = this.#requireAsset(input.assetId);
      if (
        input.kind === "waveform" &&
        input.expectedBytes !== waveformByteLength(waveformPeakCount(asset.durationUs))
      )
        throw new Error("Waveform writer requires the exact bounded artifact size");
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
      log.info(
        { operation: "write-begin", assetId: input.assetId, artifactKind: input.kind },
        "derived artifact write started",
      );
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
      const writer = this.#writerOrRetired(writerId);
      if (!writer) return;
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
      const writer = this.#writerOrRetired(writerId);
      if (!writer) return;
      if (
        !Number.isSafeInteger(result.bytes) ||
        result.bytes <= 0 ||
        result.bytes !== writer.maxEnd
      )
        throw new Error("Derived artifact size does not match written data");
      if (writer.expectedBytes && result.bytes !== writer.expectedBytes)
        throw new Error("Derived artifact does not match expected size");
      validateFinalize(writer.kind, result, this.#requireAsset(writer.assetId));
      await writer.handle.sync();
      if (writer.kind === "waveform") {
        const bytes = await readFile(writer.tempPath);
        const envelope = decodeWaveformEnvelope(Uint8Array.from(bytes).buffer);
        if (
          envelope.version !== result.waveformFormatVersion ||
          envelope.peakCount !== result.peakCount
        )
          throw new Error("Waveform payload does not match its metadata");
      }
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
      if (result.peakCount !== undefined) artifact.peakCount = result.peakCount;
      if (result.waveformFormatVersion !== undefined)
        artifact.waveformFormatVersion = result.waveformFormatVersion;
      this.#log({
        assetId: writer.assetId,
        kind: `${writer.kind}-ready`,
        detail: `${writer.kind} generated (${result.bytes} bytes)`,
      });
      await this.#refreshStorage();
      if (writer.kind === "proxy" && this.#settings.proxyGeneration === "automatic")
        await this.#queueProxyRecord(this.#requireAsset(writer.assetId));
      await this.#evictIfNeeded();
      await this.#persist();
      this.#emit();
      log.info(
        {
          operation: "write-finalize",
          assetId: writer.assetId,
          artifactKind: writer.kind,
          bytes: result.bytes,
        },
        "derived artifact write completed",
      );
    });
  }

  async updateProgress(writerId: string, progress: number): Promise<void> {
    await this.#serialize(async () => {
      if (!Number.isFinite(progress) || progress < 0 || progress > 1)
        throw new Error("Invalid derived progress");
      const writer = this.#writerOrRetired(writerId);
      if (!writer) return;
      this.#index.assets[writer.assetId]![writer.kind].progress = progress;
      this.#runtimeTracker.updateWriterProgress(writer.assetId, progress);
      const bucket = Math.min(4, Math.floor(progress * 4));
      if (this.#progressLogBuckets.get(writerId) !== bucket) {
        this.#progressLogBuckets.set(writerId, bucket);
        log.info(
          {
            operation: "worker-progress",
            assetId: writer.assetId,
            artifactKind: writer.kind,
            progress,
          },
          "derived worker progressed",
        );
      }
      this.#emit();
    });
  }

  reportActivity(scope: DerivedProjectScope, activity: DerivedWorkerActivity): void {
    if (!this.#scopeMatches(scope)) return;
    this.#runtimeTracker.reportActivity(activity);
  }

  recordProtocolRead(input: {
    assetId: string;
    start: number;
    requestedEnd: number;
    bytesRead: number;
    durationMs: number;
    range: boolean;
  }): void {
    this.#runtimeTracker.recordProtocolRead(input);
  }

  recordProtocolError(assetId: string | undefined, detail: string, durationMs: number): void {
    this.#runtimeTracker.recordProtocolError(assetId, detail, durationMs);
  }

  async cancelWrite(writerId: string, failureCode?: string, detail?: string): Promise<void> {
    await this.#serialize(async () => {
      const writer = this.#writerOrRetired(writerId);
      if (!writer) return;
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
      const context = {
        operation: "write-cancel",
        assetId: writer.assetId,
        artifactKind: writer.kind,
        ...(failureCode ? { failureCode } : {}),
        ...(detail ? { detail } : {}),
      };
      if (failureCode) log.error(context, "derived artifact generation failed");
      else log.info(context, "derived artifact write returned to the queue");
    });
  }

  async reportPerformance(
    scope: DerivedProjectScope,
    observation: DerivedPerformanceObservation,
  ): Promise<void> {
    await this.#serialize(async () => {
      if (!this.#scopeMatches(scope)) return;
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
      if (observation.latencyMs !== undefined && observation.operation === "hover-seek") {
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
      if (observation.deadlineMiss !== undefined) {
        const key = `${observation.assetId}:${observation.sourceKind}`;
        const deadlines = this.#deadlines.get(key) ?? { total: 0, missed: 0 };
        deadlines.total += 1;
        deadlines.missed += Number(observation.deadlineMiss);
        if (deadlines.total > 100) {
          deadlines.total = Math.ceil(deadlines.total / 2);
          deadlines.missed = Math.ceil(deadlines.missed / 2);
        }
        this.#deadlines.set(key, deadlines);
        summary.deadlineMissRate = deadlines.missed / deadlines.total;
      }
      this.#emit();
    });
  }

  async artifactFile(
    scope: DerivedProjectScope,
    kind: DerivedArtifactKind,
    assetId: string,
    profileId?: string,
    revision?: string,
  ): Promise<{ path: string; size: number; mimeType: string }> {
    this.assertScope(scope);
    const asset = this.#requireAsset(assetId);
    const record = this.#index.assets[asset.id];
    if (!record) throw new Error("Derived asset is unavailable");
    const artifact = record[kind];
    if (artifact.state !== "ready" || !artifact.relativePath)
      throw new Error("Derived artifact is not ready");
    if (!revision || artifact.updatedAt !== revision)
      throw new Error("Unknown derived artifact revision");
    if (kind === "proxy" && profileId && artifact.profileId !== profileId)
      throw new Error("Unknown proxy profile");
    const path = this.#containedPath(artifact.relativePath);
    const artifactMimeType = mimeType(kind);
    const info = await stat(path);
    artifact.lastAccessAt = new Date().toISOString();
    return { path, size: info.size, mimeType: artifactMimeType };
  }

  async #ensureAsset(asset: Asset): Promise<PersistedAsset> {
    const current = this.#index.assets[asset.id];
    // Moving a verified original to cloud does not change its bytes. Preserve the local edit
    // representation instead of invalidating it solely because the source locator changed.
    if (asset.source.kind === "cloud" && current) return current;
    const fingerprint =
      asset.source.kind === "local"
        ? await fingerprintSource(asset.source.path)
        : { size: 0, mtimeMs: 0, edgeHash: asset.source.cloudAssetId };
    if (current && fingerprintsEqual(current.sourceFingerprint, fingerprint)) return current;
    if (current) {
      for (const artifact of [
        current.thumbnail,
        current.filmstrip,
        current.waveform,
        current.proxy,
      ]) {
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
      generatorVersion: DERIVED_GENERATOR_VERSION,
      sourceFingerprint: fingerprint,
    });
    const record: PersistedAsset = {
      sourceFingerprint: fingerprint,
      thumbnail: emptyArtifact(),
      filmstrip: emptyArtifact(),
      waveform: emptyArtifact(),
      proxy: emptyArtifact(),
      performance: { original: emptyPerformance() },
    };
    this.#index.assets[asset.id] = record;
    return record;
  }

  async #refreshStorage(): Promise<void> {
    const directory = this.#requireDirectory();
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
    let thumbnailBytes = 0;
    let filmstripBytes = 0;
    let waveformBytes = 0;
    let proxyBytes = 0;
    for (const record of Object.values(this.#index.assets)) {
      thumbnailBytes += record.thumbnail.bytes ?? 0;
      filmstripBytes += record.filmstrip.bytes ?? 0;
      waveformBytes += record.waveform.bytes ?? 0;
      proxyBytes += record.proxy.bytes ?? 0;
    }
    this.#index.storage = {
      ...this.#index.storage,
      totalBytes: thumbnailBytes + filmstripBytes + waveformBytes + proxyBytes,
      budgetBytes,
      safetyReserveBytes,
      thumbnailBytes,
      filmstripBytes,
      waveformBytes,
      proxyBytes,
    };
  }

  async #removeInterruptedTemps(): Promise<void> {
    await Promise.all(
      ["thumbnails", "filmstrips", "waveforms", "proxies", "originals"].map(async (folder) => {
        const directory = this.#containedPath(join(".video", folder));
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

  async #pruneRemovedAssetsNow(): Promise<void> {
    const project = this.#requireProject();
    const retained = new Set<string>(project.assets.map((asset) => asset.id));
    const removedIds = [
      ...new Set([
        ...this.#removedAssetIds,
        ...Object.keys(this.#index.assets).filter((assetId) => !retained.has(assetId)),
      ]),
    ];
    if (removedIds.length === 0) return;
    const removed = new Set(removedIds);
    for (const writer of this.#writers.values()) {
      if (!removed.has(writer.assetId)) continue;
      this.#retireWriter(writer.id);
      await writer.handle.close().catch(() => undefined);
      await rm(writer.tempPath, { force: true }).catch(() => undefined);
      this.#writers.delete(writer.id);
    }
    for (const assetId of removedIds) {
      const record = this.#index.assets[assetId];
      if (record) {
        for (const artifact of [
          record.thumbnail,
          record.filmstrip,
          record.waveform,
          record.proxy,
        ]) {
          if (artifact.relativePath)
            await rm(this.#containedPath(artifact.relativePath), { force: true }).catch(
              () => undefined,
            );
        }
        delete this.#index.assets[assetId];
      }
      this.#latencies.delete(`${assetId}:original`);
      this.#latencies.delete(`${assetId}:proxy`);
      this.#deadlines.delete(`${assetId}:original`);
      this.#deadlines.delete(`${assetId}:proxy`);
      await this.#removeUnindexedAssetArtifacts(assetId);
    }
    this.#removedAssetIds.clear();
    await this.#refreshStorage();
    await this.#persist();
    this.#emit();
  }

  async #removeUnindexedAssetArtifacts(assetId: string): Promise<void> {
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
        const directory = this.#containedPath(join(".video", folder));
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

  async #evictIfNeeded(): Promise<void> {
    const storage = this.#index.storage;
    if (storage.totalBytes <= storage.budgetBytes) return;
    const candidates = Object.entries(this.#index.assets)
      .flatMap(([assetId, record]) =>
        (["proxy", "filmstrip", "waveform"] as const).map((kind) => ({
          assetId,
          kind,
          artifact: record[kind],
        })),
      )
      .filter(
        (candidate) =>
          candidate.artifact.state === "ready" &&
          candidate.artifact.relativePath &&
          !(
            candidate.kind === "proxy" &&
            this.#project?.assets.find((asset) => asset.id === candidate.assetId)?.source.kind ===
              "cloud"
          ),
      )
      .sort((left, right) => {
        const priority = { proxy: 0, filmstrip: 1, waveform: 2 } as const;
        if (left.kind !== right.kind) return priority[left.kind] - priority[right.kind];
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

  async #queueProxyRecord(asset: Asset, required = false): Promise<void> {
    if (asset.kind !== "video" && asset.kind !== "audio") return;
    if (!this.#diskHeadroomAvailable) {
      if (required) throw new Error("Insufficient disk headroom for a proxy");
      return;
    }
    const record = await this.#ensureAsset(asset);
    const profileId = this.#proxyProfileId();
    if (record.proxy.state === "ready" && record.proxy.profileId !== profileId) {
      if (record.proxy.relativePath)
        await rm(this.#containedPath(record.proxy.relativePath), { force: true });
      record.proxy.state = "missing";
      delete record.proxy.relativePath;
      delete record.proxy.bytes;
      delete record.proxy.updatedAt;
      delete record.proxy.lastAccessAt;
    }
    if (record.proxy.state === "queued") record.proxy.profileId = profileId;
    if (record.proxy.state === "missing" || record.proxy.state === "failed") {
      record.proxy.state = "queued";
      record.proxy.progress = 0;
      record.proxy.profileId = profileId;
      delete record.proxy.failureCode;
      this.#log({
        assetId: asset.id,
        kind: "proxy-queued",
        detail: `Edit proxy queued with ${profileId}`,
      });
    }
  }

  #proxyProfileId(): string {
    const settings = this.#settings;
    return [
      settings.proxyProfile,
      settings.proxyMaxLongEdge,
      settings.proxyFrameRateCap,
      settings.proxyQuality,
    ].join("-");
  }

  #containedPath(relativePath: string): string {
    const root = resolve(this.#requireDirectory(), ".video");
    const path = resolve(this.#requireDirectory(), relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Unsafe derived path");
    return path;
  }

  #writerOrRetired(id: string): WriterSession | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid derived writer ID");
    const writer = this.#writers.get(id);
    if (!writer) {
      if (this.#retiredWriters.has(id)) return null;
      throw new Error("Unknown derived writer");
    }
    if (writer.projectDirectory !== this.#requireDirectory())
      throw new Error("Unknown derived writer");
    return writer;
  }

  #scopeMatches(scope: DerivedProjectScope): boolean {
    const current = this.#requireScope();
    return scope.cacheKey === current.cacheKey && scope.epoch === current.epoch;
  }

  #retireWriter(id: string): void {
    this.#retiredWriters.add(id);
    if (this.#retiredWriters.size > MAX_RETIRED_WRITERS)
      this.#retiredWriters.delete(this.#retiredWriters.values().next().value!);
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

  #requireScope(): DerivedProjectScope {
    if (!this.#scope) throw new Error("No derived media project scope is active");
    return this.#scope;
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
    await this.#indexRepository.write(this.#requireDirectory(), this.#index);
  }

  #emit(): void {
    if (!this.#directory) return;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  async #closeWriters(): Promise<void> {
    await Promise.all(
      [...this.#writers.values()].map(async (writer) => {
        this.#retireWriter(writer.id);
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

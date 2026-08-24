import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Asset, Project } from "@cinesim/core";
import { evaluateAdaptivePolicy } from "@cinesim/engine";
import { createCinesimLogger } from "@cinesim/logging";
import type {
  BeginDerivedWrite,
  DerivedArtifactKind,
  DerivedArtifactSnapshot,
  DerivedAssetSnapshot,
  DerivedMediaEvent,
  DerivedProjectScope,
  DerivedRuntimeSnapshot,
  DerivedMediaSnapshot,
  DerivedPerformanceObservation,
  DerivedWorkerActivity,
  FinalizeDerivedWrite,
  SourceFingerprint,
  SourcePerformanceSnapshot,
} from "../shared/api";
import {
  WAVEFORM_FORMAT_VERSION,
  waveformByteLength,
  waveformPeakCount,
} from "../shared/waveform-format";

export const DERIVED_GENERATOR_VERSION = "3";
const INDEX_FILE = join(".video", "cache", "media-intelligence.json");
const MAX_WRITERS = 4;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const EDGE_BYTES = 64 * 1024;
const MAX_DECISION_EVENTS = 100;
const MAX_RETIRED_WRITERS = 256;
const log = createCinesimLogger({ service: "derived-media" });

interface PersistedArtifact extends DerivedArtifactSnapshot {
  relativePath?: string;
  generatorVersion: string;
  sourceFingerprint: SourceFingerprint;
}

interface PersistedAsset extends Omit<DerivedAssetSnapshot, "assetId" | "fingerprintStatus"> {
  sourceFingerprint: SourceFingerprint;
  thumbnail: PersistedArtifact;
  filmstrip: PersistedArtifact;
  waveform: PersistedArtifact;
  proxy: PersistedArtifact;
}

interface PersistedIndex {
  version: 1;
  generatorVersion: string;
  assets: Record<string, PersistedAsset>;
  storage: DerivedMediaSnapshot["storage"];
  decisionLog: DerivedMediaEvent[];
}

interface PreparedDerivedProject {
  directory: string;
  index: PersistedIndex;
  readDurationMs: number;
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

function emptyRuntime(): DerivedRuntimeSnapshot {
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

function emptyStorage(): DerivedMediaSnapshot["storage"] {
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

function emptyIndex(): PersistedIndex {
  return {
    version: 1,
    generatorVersion: DERIVED_GENERATOR_VERSION,
    assets: {},
    storage: emptyStorage(),
    decisionLog: [],
  };
}

function projectOpenPersistenceSignature(index: PersistedIndex): string {
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

function artifactPath(kind: DerivedArtifactKind, assetId: string, profileId?: string): string {
  if (kind === "thumbnail") return join(".video", "thumbnails", `${assetId}.jpg`);
  if (kind === "filmstrip") return join(".video", "filmstrips", `${assetId}.jpg`);
  if (kind === "waveform") return join(".video", "waveforms", `${assetId}.cswf`);
  return join(".video", "proxies", `${assetId}-${profileId ?? "edit-720p"}.mp4`);
}

function mimeType(kind: DerivedArtifactKind): string {
  if (kind === "proxy") return "video/mp4";
  if (kind === "waveform") return "application/vnd.cinesim.waveform";
  return "image/jpeg";
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
  #scope: DerivedProjectScope | null = null;
  #project: Project | null = null;
  #index: PersistedIndex = emptyIndex();
  #writers = new Map<string, WriterSession>();
  #retiredWriters = new Set<string>();
  #listeners = new Set<(snapshot: DerivedMediaSnapshot) => void>();
  #operationQueue: Promise<unknown> = Promise.resolve();
  #persistQueue: Promise<void> = Promise.resolve();
  #latencies = new Map<string, number[]>();
  #deadlines = new Map<string, { total: number; missed: number }>();
  #runtime = emptyRuntime();
  #progressLogBuckets = new Map<string, number>();
  #runtimeEmitTimer: ReturnType<typeof setTimeout> | null = null;
  #diskHeadroomAvailable = false;

  async prepareProject(directory: string): Promise<PreparedDerivedProject> {
    const startedAt = performance.now();
    const index = await this.#readIndex(directory);
    return { directory, index, readDurationMs: performance.now() - startedAt };
  }

  async setProject(
    directory: string,
    project: Project,
    prepared?: PreparedDerivedProject,
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
      this.#latencies.clear();
      this.#deadlines.clear();
      this.#runtime = emptyRuntime();
      this.#progressLogBuckets.clear();
      if (this.#runtimeEmitTimer) clearTimeout(this.#runtimeEmitTimer);
      this.#runtimeEmitTimer = null;
      this.#index = usePreparedIndex ? prepared.index : await this.#readIndex(directory);
      const persistenceSignature = projectOpenPersistenceSignature(this.#index);
      await this.#removeInterruptedTemps();
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
        if (record.filmstrip.state === "ready" && !this.#validFilmstripMetadata(record.filmstrip)) {
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
      for (const asset of project.assets) this.#applyAdaptiveDecision(asset.id);
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
    this.#project = project;
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
      runtime: structuredClone(this.#runtime),
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
          if (artifact.state === "missing" || artifact.state === "failed")
            artifact.state = "queued";
        }
      }
      if (projectOpenPersistenceSignature(this.#index) !== persistenceSignature)
        await this.#persist();
      this.#emit();
      return this.snapshot();
    });
  }

  async beginWrite(
    scope: DerivedProjectScope,
    input: BeginDerivedWrite,
  ): Promise<{ writerId: string }> {
    return this.#serialize(async () => {
      this.assertScope(scope);
      this.#validateWriteInput(input);
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
      this.#validateFinalize(writer.kind, result, this.#requireAsset(writer.assetId));
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
      if (result.peakCount !== undefined) artifact.peakCount = result.peakCount;
      if (result.waveformFormatVersion !== undefined)
        artifact.waveformFormatVersion = result.waveformFormatVersion;
      this.#log({
        assetId: writer.assetId,
        kind: `${writer.kind}-ready`,
        detail: `${writer.kind} generated (${result.bytes} bytes)`,
      });
      await this.#refreshStorage();
      this.#applyAdaptiveDecision(writer.assetId);
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
      const active = this.#runtime.activeJob;
      if (active?.assetId === writer.assetId) {
        active.progress = progress;
        active.lastActivityAt = new Date().toISOString();
      }
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
    const now = new Date().toISOString();
    if (activity.stage === "scheduled" || this.#runtime.activeJob?.jobId !== activity.jobId) {
      this.#runtime.activeJob = {
        jobId: activity.jobId,
        assetId: activity.assetId,
        jobKind: activity.jobKind,
        stage: activity.stage,
        progress:
          activity.completedSamples !== undefined && activity.totalSamples
            ? activity.completedSamples / activity.totalSamples
            : 0,
        elapsedMs: activity.elapsedMs,
        startedAt: now,
        lastActivityAt: now,
        ...(activity.completedSamples !== undefined
          ? { completedSamples: activity.completedSamples }
          : {}),
        ...(activity.totalSamples !== undefined ? { totalSamples: activity.totalSamples } : {}),
      };
    } else {
      const active = this.#runtime.activeJob;
      active.stage = activity.stage;
      active.elapsedMs = activity.elapsedMs;
      active.lastActivityAt = now;
      if (activity.completedSamples !== undefined)
        active.completedSamples = activity.completedSamples;
      if (activity.totalSamples !== undefined) active.totalSamples = activity.totalSamples;
      if (activity.completedSamples !== undefined && activity.totalSamples)
        active.progress = activity.completedSamples / activity.totalSamples;
    }
    log.info(
      {
        operation: "worker-activity",
        jobId: activity.jobId,
        assetId: activity.assetId,
        jobKind: activity.jobKind,
        stage: activity.stage,
        elapsedMs: activity.elapsedMs,
        ...(activity.completedSamples !== undefined
          ? { completedSamples: activity.completedSamples }
          : {}),
        ...(activity.totalSamples !== undefined ? { totalSamples: activity.totalSamples } : {}),
        ...(activity.failureCode ? { failureCode: activity.failureCode } : {}),
        ...(activity.detail ? { detail: activity.detail } : {}),
      },
      "derived worker activity",
    );
    if (activity.stage === "completed" || activity.stage === "failed") {
      this.#runtime.lastJob = {
        assetId: activity.assetId,
        jobKind: activity.jobKind,
        stage: activity.stage,
        durationMs: activity.elapsedMs,
        finishedAt: now,
        ...(activity.failureCode ? { failureCode: activity.failureCode } : {}),
      };
      delete this.#runtime.activeJob;
    }
    this.#emit();
  }

  recordProtocolRead(input: {
    assetId: string;
    start: number;
    requestedEnd: number;
    bytesRead: number;
    durationMs: number;
    range: boolean;
  }): void {
    const protocol = this.#runtime.protocol;
    protocol.requests += 1;
    protocol.rangeRequests += Number(input.range);
    protocol.bytesRead += input.bytesRead;
    protocol.averageLatencyMs += (input.durationMs - protocol.averageLatencyMs) / protocol.requests;
    protocol.lastLatencyMs = input.durationMs;
    protocol.lastBytesRead = input.bytesRead;
    protocol.lastAssetId = input.assetId;
    log.info(
      {
        operation: "protocol-read",
        projectCacheKey: this.#scope?.cacheKey,
        projectEpoch: this.#scope?.epoch,
        assetId: input.assetId,
        start: input.start,
        requestedEnd: input.requestedEnd,
        bytesRead: input.bytesRead,
        durationMs: input.durationMs,
        range: input.range,
      },
      "media protocol range served",
    );
    this.#scheduleRuntimeEmit();
  }

  recordProtocolError(assetId: string | undefined, detail: string, durationMs: number): void {
    this.#runtime.protocol.errors += 1;
    log.error(
      {
        operation: "protocol-error",
        projectCacheKey: this.#scope?.cacheKey,
        projectEpoch: this.#scope?.epoch,
        ...(assetId ? { assetId } : {}),
        detail,
        durationMs,
      },
      "media protocol request failed",
    );
    this.#scheduleRuntimeEmit();
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
      this.#applyAdaptiveDecision(writer.assetId);
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
      if (this.#applyAdaptiveDecision(observation.assetId)) await this.#persist();
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
    const fingerprint = await this.#fingerprint(asset.source.path);
    const current = this.#index.assets[asset.id];
    if (current && this.#fingerprintsEqual(current.sourceFingerprint, fingerprint)) return current;
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
      if (value.version !== 1 || value.generatorVersion !== DERIVED_GENERATOR_VERSION)
        return emptyIndex();
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
      ["thumbnails", "filmstrips", "waveforms", "proxies"].map(async (folder) => {
        const directory = this.#containedPath(join(".video", folder));
        const names = await readdir(directory).catch(() => []);
        await Promise.all(
          names
            .filter((name) => name.endsWith(".tmp") && /^[a-zA-Z0-9_.-]+$/.test(name))
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
        (candidate) => candidate.artifact.state === "ready" && candidate.artifact.relativePath,
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

  #applyAdaptiveDecision(assetId: string): boolean {
    const record = this.#index.assets[assetId];
    if (!record) return false;
    const result = evaluateAdaptivePolicy({
      ...record.performance.original,
      proxyState: record.proxy.state,
      diskHeadroomAvailable:
        this.#diskHeadroomAvailable &&
        this.#index.storage.totalBytes < this.#index.storage.budgetBytes * 0.9,
    });
    const previousDecision = record.performance.decision;
    const previousReasons = record.performance.reasons.join(",");
    const previousProxyState = record.proxy.state;
    record.performance.decision = result.decision;
    record.performance.reasons = result.reasons;
    if (result.queueProxy && record.proxy.state === "missing") record.proxy.state = "queued";
    if (
      previousDecision !== record.performance.decision ||
      previousReasons !== record.performance.reasons.join(",")
    )
      this.#log({
        assetId,
        kind: "adaptive-decision",
        detail: `${record.performance.decision}: ${record.performance.reasons.join(", ")}`,
      });
    return (
      previousDecision !== record.performance.decision ||
      previousReasons !== record.performance.reasons.join(",") ||
      previousProxyState !== record.proxy.state
    );
  }

  #validateWriteInput(input: BeginDerivedWrite): void {
    if (!isAssetId(input.assetId)) throw new Error("Invalid asset ID");
    if (!["thumbnail", "filmstrip", "waveform", "proxy"].includes(input.kind))
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

  #validateFinalize(kind: DerivedArtifactKind, result: FinalizeDerivedWrite, asset: Asset): void {
    for (const value of [
      result.sourceTimeUs,
      result.columns,
      result.rows,
      result.tileWidth,
      result.tileHeight,
      result.peakCount,
      result.waveformFormatVersion,
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
    if (kind === "filmstrip" && !this.#validFilmstripMetadata(result))
      throw new Error("Incomplete or inconsistent filmstrip metadata");
    if (
      kind === "waveform" &&
      (result.waveformFormatVersion !== WAVEFORM_FORMAT_VERSION ||
        result.peakCount !== waveformPeakCount(asset.durationUs) ||
        result.bytes !== waveformByteLength(result.peakCount))
    )
      throw new Error("Incomplete or inconsistent waveform metadata");
    if (
      kind !== "waveform" &&
      (result.peakCount !== undefined || result.waveformFormatVersion !== undefined)
    )
      throw new Error("Waveform metadata is only valid for waveforms");
  }

  #validFilmstripMetadata(
    value: Pick<
      DerivedArtifactSnapshot,
      "tileTimesUs" | "columns" | "rows" | "tileWidth" | "tileHeight"
    >,
  ): boolean {
    const { tileTimesUs, columns, rows, tileWidth, tileHeight } = value;
    return Boolean(
      tileTimesUs?.length &&
      Number.isSafeInteger(columns) &&
      columns! > 0 &&
      Number.isSafeInteger(rows) &&
      rows === Math.ceil(tileTimesUs.length / columns!) &&
      Number.isSafeInteger(tileWidth) &&
      tileWidth! > 0 &&
      Number.isSafeInteger(tileHeight) &&
      tileHeight! > 0,
    );
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
    const path = join(this.#requireDirectory(), INDEX_FILE);
    const contents = `${JSON.stringify(this.#index, null, 2)}\n`;
    const operation = async () => {
      const tempPath = `${path}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tempPath, contents, "utf8");
      await rename(tempPath, path);
    };
    const result = this.#persistQueue.catch(() => undefined).then(operation);
    this.#persistQueue = result;
    return result;
  }

  #emit(): void {
    if (!this.#directory) return;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #scheduleRuntimeEmit(): void {
    if (this.#runtimeEmitTimer) return;
    this.#runtimeEmitTimer = setTimeout(() => {
      this.#runtimeEmitTimer = null;
      this.#emit();
    }, 250);
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

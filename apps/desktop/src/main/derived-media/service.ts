import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { relative } from "node:path";
import { DEFAULT_SETTINGS } from "@cinesim/core";
import type { Asset, Project, ProjectSettings } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { ProjectPaths } from "@cinesim/project-io";
import type {
  BeginDerivedWrite,
  DerivedArtifactKind,
  DerivedMediaEvent,
  DerivedProjectScope,
  DerivedMediaSnapshot,
  DerivedPerformanceObservation,
  DerivedWorkerActivity,
  FinalizeDerivedWrite,
  SourceFingerprint,
} from "../../shared/api";
import { decodeWaveformEnvelope } from "../../shared/waveform-format";
import { validateFinalize, validFilmstripMetadata } from "./artifact-validation";
import { DerivedArtifactRepository } from "./artifact-repository";
import { DerivedIndexRepository } from "./index-repository";
import { type DerivedProjectLifecycle, requireOpenDerivedProject } from "./project-lifecycle";
import { isAssetId, MAX_DECISION_EVENTS, projectOpenPersistenceSignature } from "./model";
import type { PersistedAsset, PersistedIndex, PreparedDerivedProject } from "./model";

export { DERIVED_GENERATOR_VERSION } from "./model";
import { DerivedPerformanceTracker } from "./performance-tracker";
import { DerivedRuntimeTracker } from "./runtime-tracker";
import { projectDerivedSnapshot } from "./snapshot-projector";
import { DerivedOperationQueue } from "./operation-queue";
import { DerivedWriterRegistry } from "./writer-registry";

const log = createCinesimLogger({ service: "derived-media" });

const DERIVED_FOLDERS = [
  "cache",
  "proxies",
  "originals",
  "thumbnails",
  "waveforms",
  "filmstrips",
  "frames",
  "runtime",
  "transcripts",
] as const;

interface DerivedMediaStoreOptions {
  diskSpace?: { capacityBytes: number; availableBytes: number };
}

export class DerivedMediaStore {
  #lifecycle: DerivedProjectLifecycle = { status: "closed" };
  #listeners = new Set<(snapshot: DerivedMediaSnapshot) => void>();
  #indexRepository = new DerivedIndexRepository();
  #artifactRepository: DerivedArtifactRepository;
  #writers = new DerivedWriterRegistry();
  #operations = new DerivedOperationQueue();
  #performanceTracker = new DerivedPerformanceTracker();
  #removedAssetIds = new Set<string>();
  #runtimeTracker = new DerivedRuntimeTracker(
    () => this.#emit(),
    () => this.#scope,
  );

  constructor(options: DerivedMediaStoreOptions = {}) {
    this.#artifactRepository = new DerivedArtifactRepository(options);
  }

  get #directory(): string | null {
    return this.#lifecycle.status === "open" ? this.#lifecycle.directory : null;
  }

  get #paths(): ProjectPaths | null {
    return this.#lifecycle.status === "open" ? this.#lifecycle.paths : null;
  }

  get #scope(): DerivedProjectScope | null {
    return this.#lifecycle.status === "open" ? this.#lifecycle.scope : null;
  }

  get #project(): Project | null {
    return this.#lifecycle.status === "open" ? this.#lifecycle.project : null;
  }

  set #project(project: Project) {
    requireOpenDerivedProject(this.#lifecycle).project = project;
  }

  get #settings(): ProjectSettings {
    return this.#lifecycle.status === "open" ? this.#lifecycle.settings : DEFAULT_SETTINGS;
  }

  set #settings(settings: ProjectSettings) {
    requireOpenDerivedProject(this.#lifecycle).settings = settings;
  }

  get #index(): PersistedIndex {
    return requireOpenDerivedProject(this.#lifecycle).index;
  }

  async prepareProject(directory: string): Promise<PreparedDerivedProject> {
    const startedAt = performance.now();
    const paths = await ProjectPaths.open(directory);
    await paths.ensureLayout(DERIVED_FOLDERS);
    const index = await this.#indexRepository.read(paths);
    return { directory: paths.canonicalRoot, index, readDurationMs: performance.now() - startedAt };
  }

  async setProject(
    directory: string,
    project: Project,
    prepared?: PreparedDerivedProject,
    settings: ProjectSettings = DEFAULT_SETTINGS,
  ): Promise<void> {
    const paths = await ProjectPaths.open(directory);
    await paths.ensureLayout(DERIVED_FOLDERS);
    const canonicalDirectory = paths.canonicalRoot;
    await this.#serialize(async () => {
      // A prepared index is safe for a different, inactive project. Reopening the active
      // directory must read again after queued writer operations have finished.
      const usePreparedIndex =
        prepared?.directory === canonicalDirectory && this.#directory !== canonicalDirectory;
      await this.#closeWriters();
      const index = usePreparedIndex ? prepared.index : await this.#indexRepository.read(paths);
      this.#lifecycle = {
        status: "open",
        directory: paths.root,
        paths,
        scope: {
          cacheKey: createHash("sha256").update(canonicalDirectory).digest("hex").slice(0, 24),
          epoch: randomUUID(),
        },
        project,
        settings: structuredClone(settings),
        index,
      };
      this.#performanceTracker.reset();
      this.#runtimeTracker.reset();
      this.#removedAssetIds.clear();
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
          projectCacheKey: this.#requireScope().cacheKey,
          projectEpoch: this.#requireScope().epoch,
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
      this.#performanceTracker.reset();
      this.#removedAssetIds.clear();
      this.#runtimeTracker.reset();
      this.#lifecycle = { status: "closed" };
    });
  }

  scope(): DerivedProjectScope {
    return structuredClone(this.#requireScope());
  }

  assertScope(scope: DerivedProjectScope): void {
    if (!this.#scopeMatches(scope)) throw new Error("Stale derived media project scope");
  }

  async sourceFingerprint(assetId: string): Promise<SourceFingerprint> {
    return this.#serialize(async () => {
      const asset = this.#requireAsset(assetId);
      return structuredClone((await this.#ensureAsset(asset)).sourceFingerprint);
    });
  }

  subscribe(listener: (snapshot: DerivedMediaSnapshot) => void): () => void {
    this.#listeners.add(listener);
    if (this.#directory) listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  snapshot(): DerivedMediaSnapshot {
    return projectDerivedSnapshot({
      project: this.#requireProject(),
      scope: this.#requireScope(),
      index: this.#index,
      runtime: this.#runtimeTracker.snapshot(),
    });
  }

  async requestJobs(scope: DerivedProjectScope, assetIds: string[]): Promise<DerivedMediaSnapshot> {
    return this.#serialize(async () => {
      this.assertScope(scope);
      return this.#queueRequestedArtifacts(assetIds, true);
    });
  }

  async queuePerception(assetIds: string[]): Promise<DerivedMediaSnapshot> {
    return this.#serialize(() => this.#queueRequestedArtifacts(assetIds, false));
  }

  async waitForPerception(assetId: string, signal?: AbortSignal): Promise<void> {
    const terminal = (snapshot: DerivedMediaSnapshot): boolean => {
      const asset = this.#requireAsset(assetId);
      const record = snapshot.assets[assetId];
      if (!record) return false;
      const kinds: DerivedArtifactKind[] = [];
      if (asset.kind === "video") kinds.push("thumbnail", "filmstrip");
      if (asset.kind === "audio" || asset.hasAudio === true) kinds.push("waveform");
      return kinds.every(
        (kind) => record[kind].state === "ready" || record[kind].state === "failed",
      );
    };
    if (terminal(this.snapshot())) return;
    if (signal?.aborted) throw new Error("Cloud transfer canceled");
    await new Promise<void>((resolve, reject) => {
      let stop: () => void = () => undefined;
      let settled = false;
      const abort = () => {
        settled = true;
        stop();
        reject(new Error("Cloud transfer canceled"));
      };
      stop = this.subscribe((snapshot) => {
        if (!terminal(snapshot)) return;
        settled = true;
        stop();
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      if (settled) stop();
      else {
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }
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

  async #queueRequestedArtifacts(
    assetIds: string[],
    queueConfiguredProxies: boolean,
  ): Promise<DerivedMediaSnapshot> {
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
      if (
        queueConfiguredProxies &&
        (this.#settings.proxyGeneration === "automatic" || asset.source.kind === "cloud")
      )
        await this.#queueProxyRecord(asset);
    }
    if (projectOpenPersistenceSignature(this.#index) !== persistenceSignature)
      await this.#persist();
    this.#emit();
    return this.snapshot();
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
      if (input.kind === "proxy" && !this.#artifactRepository.diskHeadroomAvailable)
        throw new Error("Insufficient disk headroom for a proxy");
      const directory = this.#requireDirectory();
      const asset = this.#requireAsset(input.assetId);
      const record = await this.#ensureAsset(asset);
      const writer = await this.#writers.begin(directory, this.#requirePaths(), asset, input);
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
      return { writerId: writer.id };
    });
  }

  async writeChunk(writerId: string, offset: number, data: Uint8Array): Promise<void> {
    await this.#serialize(async () => {
      const writer = await this.#writers.writeChunk(
        writerId,
        this.#requireDirectory(),
        this.#index,
        offset,
        data,
      );
      if (!writer) return;
      this.#emit();
    });
  }

  async finalizeWrite(writerId: string, result: FinalizeDerivedWrite): Promise<void> {
    await this.#serialize(async () => {
      const writer = this.#writers.get(writerId, this.#requireDirectory());
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
      this.#writers.complete(writer.id);
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
      await this.#artifactRepository.refreshStorage(this.#requireDirectory(), this.#index);
      if (writer.kind === "proxy" && this.#settings.proxyGeneration === "automatic")
        await this.#queueProxyRecord(this.#requireAsset(writer.assetId));
      await this.#artifactRepository.evict(
        this.#requirePaths(),
        this.#requireDirectory(),
        this.#index,
        this.#requireProject(),
        (event) => this.#log(event),
      );
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
      const writer = this.#writers.get(writerId, this.#requireDirectory());
      if (!writer) return;
      this.#index.assets[writer.assetId]![writer.kind].progress = progress;
      this.#runtimeTracker.updateWriterProgress(writer.assetId, progress);
      if (this.#writers.progressBucket(writerId, progress)) {
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
      const writer = this.#writers.get(writerId, this.#requireDirectory());
      if (!writer) return;
      await this.#writers.cancel(writer);
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
      this.#performanceTracker.record(record, observation);
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
    return this.#artifactRepository.artifactFile(
      this.#requirePaths(),
      this.#index,
      kind,
      asset.id,
      profileId,
      revision,
    );
  }

  async #ensureAsset(asset: Asset): Promise<PersistedAsset> {
    return this.#artifactRepository.ensureAsset(this.#requirePaths(), this.#index, asset, (event) =>
      this.#log(event),
    );
  }

  async #refreshStorage(): Promise<void> {
    await this.#artifactRepository.refreshStorage(this.#requireDirectory(), this.#index);
  }

  async #removeInterruptedTemps(): Promise<void> {
    await this.#artifactRepository.removeInterruptedTemps(this.#requirePaths());
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
    await this.#writers.removeAssets(removed);
    await this.#artifactRepository.removeAssets(this.#requirePaths(), this.#index, removedIds);
    for (const assetId of removedIds) {
      this.#performanceTracker.remove(assetId);
    }
    this.#removedAssetIds.clear();
    await this.#refreshStorage();
    await this.#persist();
    this.#emit();
  }

  async #queueProxyRecord(asset: Asset, required = false): Promise<void> {
    if (asset.kind !== "video" && asset.kind !== "audio") return;
    if (!this.#artifactRepository.diskHeadroomAvailable) {
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
    return this.#requirePaths().derived(relativePath);
  }

  #scopeMatches(scope: DerivedProjectScope): boolean {
    const current = this.#requireScope();
    return scope.cacheKey === current.cacheKey && scope.epoch === current.epoch;
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

  #requirePaths(): ProjectPaths {
    if (!this.#paths) throw new Error("No project is open");
    return this.#paths;
  }

  #requireScope(): DerivedProjectScope {
    if (!this.#scope) throw new Error("No derived media project scope is active");
    return this.#scope;
  }

  #requireProject(): Project {
    if (!this.#project) throw new Error("No project is open");
    return this.#project;
  }

  #log(event: Omit<DerivedMediaEvent, "at">): void {
    this.#index.decisionLog.push({ ...event, at: new Date().toISOString() });
    if (this.#index.decisionLog.length > MAX_DECISION_EVENTS)
      this.#index.decisionLog.splice(0, this.#index.decisionLog.length - MAX_DECISION_EVENTS);
  }

  async #persist(): Promise<void> {
    await this.#indexRepository.write(this.#requirePaths(), this.#index);
  }

  #emit(): void {
    if (!this.#directory) return;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  async #closeWriters(): Promise<void> {
    await this.#writers.closeAll();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.#operations.serialize(this.#paths, DERIVED_FOLDERS, operation);
  }
}

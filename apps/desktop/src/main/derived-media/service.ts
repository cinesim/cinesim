import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
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
} from "../../shared/contracts";
import { validFilmstripMetadata } from "./artifact-validation";
import { DerivedArtifactRepository } from "./artifact-repository";
import { DerivedIndexRepository } from "./index-repository";
import { DerivedJobCoordinator } from "./job-coordinator";
import {
  activeDerivedProject,
  beginDerivedProjectPreparation,
  completeDerivedProjectPreparation,
  type DerivedProjectLifecycle,
  failDerivedProjectPreparation,
  requireOpenDerivedProject,
} from "./project-lifecycle";
import { isAssetId, MAX_DECISION_EVENTS, projectOpenPersistenceSignature } from "./model";
import type { PersistedAsset, PersistedIndex, PreparedDerivedProject } from "./model";

export { DERIVED_GENERATOR_VERSION } from "./model";
import { DerivedPerformanceTracker } from "./performance-tracker";
import { DerivedRuntimeTracker } from "./runtime-tracker";
import { projectDerivedSnapshot } from "./snapshot-projector";
import { DerivedOperationQueue } from "./operation-queue";
import { DerivedWriteCoordinator } from "./write-coordinator";

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
  #jobs: DerivedJobCoordinator;
  #writes: DerivedWriteCoordinator;
  #operations = new DerivedOperationQueue();
  #performanceTracker = new DerivedPerformanceTracker();
  #removedAssetIds = new Set<string>();
  #runtimeTracker = new DerivedRuntimeTracker(
    () => this.#emit(),
    () => this.#scope,
  );

  constructor(options: DerivedMediaStoreOptions = {}) {
    this.#artifactRepository = new DerivedArtifactRepository(options);
    this.#jobs = new DerivedJobCoordinator(
      {
        serialize: (operation) => this.#serialize(operation),
        assertScope: (scope) => this.assertScope(scope),
        project: () => this.#requireProject(),
        settings: () => this.#settings,
        index: () => this.#index,
        asset: (assetId) => this.#requireAsset(assetId),
        ensureAsset: (asset) => this.#ensureAsset(asset),
        containedPath: (relativePath) => this.#containedPath(relativePath),
        persist: () => this.#persist(),
        emit: () => this.#emit(),
        snapshot: () => this.snapshot(),
        subscribe: (listener) => this.subscribe(listener),
        log: (event) => this.#log(event),
      },
      this.#artifactRepository,
    );
    this.#writes = new DerivedWriteCoordinator(
      {
        serialize: (operation) => this.#serialize(operation),
        assertScope: (scope) => this.assertScope(scope),
        directory: () => this.#requireDirectory(),
        paths: () => this.#requirePaths(),
        project: () => this.#requireProject(),
        settings: () => this.#settings,
        index: () => this.#index,
        asset: (assetId) => this.#requireAsset(assetId),
        ensureAsset: (asset) => this.#ensureAsset(asset),
        queueProxy: (asset) => this.#jobs.queueProxyRecord(asset),
        updateRuntimeProgress: (assetId, progress) =>
          this.#runtimeTracker.updateWriterProgress(assetId, progress),
        persist: () => this.#persist(),
        emit: () => this.#emit(),
        log: (event) => this.#log(event),
      },
      this.#artifactRepository,
    );
  }

  get #directory(): string | null {
    return activeDerivedProject(this.#lifecycle)?.directory ?? null;
  }

  get #paths(): ProjectPaths | null {
    return activeDerivedProject(this.#lifecycle)?.paths ?? null;
  }

  get #scope(): DerivedProjectScope | null {
    return activeDerivedProject(this.#lifecycle)?.scope ?? null;
  }

  get #project(): Project | null {
    return activeDerivedProject(this.#lifecycle)?.project ?? null;
  }

  set #project(project: Project) {
    requireOpenDerivedProject(this.#lifecycle).project = project;
  }

  get #settings(): ProjectSettings {
    return activeDerivedProject(this.#lifecycle)?.settings ?? DEFAULT_SETTINGS;
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
      const preparing = beginDerivedProjectPreparation(this.#lifecycle, paths.root);
      this.#lifecycle = preparing;
      try {
        // A prepared index is safe for a different, inactive project. Reopening the active
        // directory must read again after queued writer operations have finished.
        const usePreparedIndex =
          prepared?.directory === canonicalDirectory && this.#directory !== canonicalDirectory;
        await this.#closeWriters();
        const index = usePreparedIndex ? prepared.index : await this.#indexRepository.read(paths);
        this.#lifecycle = completeDerivedProjectPreparation(preparing, {
          directory: paths.root,
          paths,
          scope: {
            cacheKey: createHash("sha256").update(canonicalDirectory).digest("hex").slice(0, 24),
            epoch: randomUUID(),
          },
          project,
          settings: structuredClone(settings),
          index,
        });
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
            await this.#jobs.queueProxyRecord(asset);
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
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#lifecycle = failDerivedProjectPreparation(preparing, failure);
        throw failure;
      }
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
          await this.#jobs.queueProxyRecord(asset);
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
    return this.#jobs.request(scope, assetIds);
  }

  async queuePerception(assetIds: string[]): Promise<DerivedMediaSnapshot> {
    return this.#jobs.queuePerception(assetIds);
  }

  async waitForPerception(assetId: string, signal?: AbortSignal): Promise<void> {
    await this.#jobs.waitForPerception(assetId, signal);
  }

  async queueProxy(assetId: string): Promise<DerivedMediaSnapshot> {
    return this.#jobs.queueProxy(assetId);
  }

  async queueProxies(
    scope: DerivedProjectScope,
    assetIds: string[],
  ): Promise<DerivedMediaSnapshot> {
    return this.#jobs.queueProxies(scope, assetIds);
  }

  async waitForProxy(assetId: string, signal?: AbortSignal): Promise<void> {
    await this.#jobs.waitForProxy(assetId, signal);
  }

  async beginWrite(
    scope: DerivedProjectScope,
    input: BeginDerivedWrite,
  ): Promise<{ writerId: string }> {
    return this.#writes.begin(scope, input);
  }

  async writeChunk(writerId: string, offset: number, data: Uint8Array): Promise<void> {
    await this.#writes.writeChunk(writerId, offset, data);
  }

  async finalizeWrite(writerId: string, result: FinalizeDerivedWrite): Promise<void> {
    await this.#writes.finalize(writerId, result);
  }

  async updateProgress(writerId: string, progress: number): Promise<void> {
    await this.#writes.updateProgress(writerId, progress);
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
    await this.#writes.cancel(writerId, failureCode, detail);
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
    await this.#writes.removeAssets(removed);
    await this.#artifactRepository.removeAssets(this.#requirePaths(), this.#index, removedIds);
    for (const assetId of removedIds) {
      this.#performanceTracker.remove(assetId);
    }
    this.#removedAssetIds.clear();
    await this.#refreshStorage();
    await this.#persist();
    this.#emit();
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
    await this.#writes.closeAll();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.#operations.serialize(this.#paths, DERIVED_FOLDERS, operation);
  }
}

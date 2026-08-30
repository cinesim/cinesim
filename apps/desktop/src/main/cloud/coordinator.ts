import { stat } from "node:fs/promises";
import type { Asset, Project } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import type { CloudStorageUsage, CloudTransferSnapshot } from "../../shared/contracts";
import type { DesktopAccountService } from "../account/service";
import type { DesktopProjectStore } from "../projects/project-store";
import { CloudStorageGateway } from "./gateway";
import { MAX_QUEUED_ASSETS, PROGRESS_PUBLICATION_INTERVAL_MS } from "./limits";
import { MultipartUploader } from "./multipart-uploader";
import { CloudOriginalCache } from "./original-cache";
import { CloudTransferRepository } from "./transfer-repository";
import type { TransferRecord } from "./transfer-repository";
import { CloudUploadScheduler } from "./upload-scheduler";
import { CloudAssetService } from "./asset-service";
import { CloudOriginalReader } from "./original-reader";
import { CloudUploadRunner } from "./upload-runner";

const log = createCinesimLogger({ service: "cloud-media" });

const assetIdPattern = /^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

interface QueueContext {
  project: Project;
  cloudProjectId: string;
  directory: string;
  userId: string;
  cloudAvailable: boolean;
  managedSources: Set<string>;
}

function validateQueueRequest(assetIds: string[], managedSourceAssetIds: string[]): void {
  if (
    assetIds.length === 0 ||
    assetIds.length > MAX_QUEUED_ASSETS ||
    assetIds.some((id) => !assetIdPattern.test(id))
  ) {
    throw new Error("Invalid cloud storage request");
  }

  const requestedAssetIds = new Set(assetIds);
  if (managedSourceAssetIds.some((assetId) => !requestedAssetIds.has(assetId))) {
    throw new Error("Invalid managed cloud storage request");
  }
}

function selectedAssets(project: Project, assetIds: string[]): Asset[] {
  return [...new Set(assetIds)].map((assetId) => {
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error("The selected media is no longer in this project");
    if (asset.kind === "image") {
      throw new Error("Cloud originals for still images are not supported in this build");
    }
    return asset;
  });
}

function canRestart(record: TransferRecord): boolean {
  return (
    record.state === "waiting-for-cloud" || record.state === "paused" || record.state === "failed"
  );
}

export class CloudMediaCoordinator {
  readonly #records = new Map<string, TransferRecord>();
  readonly #scheduler = new CloudUploadScheduler();
  readonly #lastProgressPublication = new Map<string, number>();
  readonly #gateway: CloudStorageGateway;
  readonly #uploader: MultipartUploader;
  readonly #repository: CloudTransferRepository;
  readonly #originalCache: CloudOriginalCache;
  readonly #assets: CloudAssetService;
  readonly #originalReader: CloudOriginalReader;
  readonly #uploadRunner: CloudUploadRunner;

  constructor(
    journalPath: string,
    private readonly account: DesktopAccountService,
    private readonly projects: DesktopProjectStore,
    private readonly events: {
      transfersChanged(snapshot: CloudTransferSnapshot[]): void;
      projectChanged(session: ReturnType<DesktopProjectStore["session"]>): void;
    } = { transfersChanged: () => undefined, projectChanged: () => undefined },
  ) {
    this.#gateway = new CloudStorageGateway(account);
    this.#uploader = new MultipartUploader(this.#gateway);
    this.#repository = new CloudTransferRepository(journalPath);
    this.#assets = new CloudAssetService(this.#gateway);
    this.#originalReader = new CloudOriginalReader(this.#gateway);
    this.#originalCache = new CloudOriginalCache(projects, (cloudAssetId) =>
      this.#originalReader.signedDownload(cloudAssetId),
    );
    this.#uploadRunner = new CloudUploadRunner(
      account,
      projects,
      this.#gateway,
      this.#uploader,
      this.#originalCache,
      {
        persistAndEmit: () => this.#persistAndEmit(),
        publishProgress: (key) => this.#publishProgress(key),
        projectChanged: () => this.#emitProject(),
      },
    );
  }

  async load(): Promise<void> {
    try {
      const records = await this.#repository.load();
      for (const record of records)
        this.#records.set(this.#recordKey(record), {
          ...record,
          state:
            record.state === "preparing" ||
            record.state === "uploading" ||
            record.state === "waiting-for-proxy"
              ? "paused"
              : record.state,
        });
    } catch (error) {
      log.warn(
        { err: error, operation: "journal-load" },
        "Ignored an invalid cloud transfer journal",
      );
    }
  }

  snapshots(): CloudTransferSnapshot[] {
    const userId = this.account.cachedUser()?.id;
    const projectDirectory = this.projects.directory;
    return [...this.#records.values()]
      .filter((record) => record.userId === userId && record.projectDirectory === projectDirectory)
      .map(({ assetId, cloudAssetId, name, bytes, uploadedBytes, state, error }) => ({
        assetId,
        cloudAssetId,
        name,
        bytes,
        uploadedBytes,
        state,
        error,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async usage(): Promise<CloudStorageUsage> {
    return this.#assets.usage();
  }

  async configureAddon(addonBytes: number): Promise<CloudStorageUsage> {
    return this.#assets.configureAddon(addonBytes);
  }

  async readOriginal(
    cloudAssetId: string,
    request: Request,
    accessControlOrigin: string,
  ): Promise<Response> {
    return this.#originalReader.read(cloudAssetId, request, accessControlOrigin);
  }

  async downloadedOriginals(): Promise<string[]> {
    return this.#originalCache.downloadedOriginals();
  }

  async downloadedOriginalPath(assetId: string): Promise<string | null> {
    return this.#originalCache.downloadedOriginalPath(assetId);
  }

  async keepDownloaded(assetId: string): Promise<string[]> {
    return this.#originalCache.keepDownloaded(assetId);
  }

  async removeDownload(assetId: string): Promise<string[]> {
    return this.#originalCache.removeDownload(assetId);
  }

  async queue(
    assetIds: string[],
    managedSourceAssetIds: string[] = [],
  ): Promise<CloudTransferSnapshot[]> {
    validateQueueRequest(assetIds, managedSourceAssetIds);
    const context = await this.#queueContext(managedSourceAssetIds);
    const assets = selectedAssets(context.project, assetIds);

    for (const asset of assets) await this.#queueAsset(context, asset);
    await this.#persistAndEmit();
    return this.snapshots();
  }

  async #queueContext(managedSourceAssetIds: string[]): Promise<QueueContext> {
    const project = this.projects.project;
    const directory = this.projects.directory;
    if (!project || !directory) throw new Error("Open a project before storing media in cloud");
    if (!project.cloudProjectId) throw new Error("This project is not registered to an account");
    const user = this.account.requireCachedUser();
    const account = await this.account.snapshot();
    return {
      project,
      cloudProjectId: project.cloudProjectId,
      directory,
      userId: user.id,
      cloudAvailable: account.status === "signed-in" && account.cloudStorage === true,
      managedSources: new Set(managedSourceAssetIds),
    };
  }

  async #queueAsset(context: QueueContext, asset: Asset): Promise<void> {
    if (asset.source.kind === "cloud") return;
    const sourcePath = asset.source.path;
    const key = this.#recordKey({
      userId: context.userId,
      projectDirectory: context.directory,
      assetId: asset.id,
    });
    if (this.#scheduler.has(key)) return;

    const existing = this.#records.get(key);
    if (existing && canRestart(existing)) {
      this.#restartRecord(
        key,
        existing,
        context.managedSources.has(asset.id),
        context.cloudAvailable,
      );
      return;
    }

    const info = await stat(sourcePath);
    if (!info.isFile() || info.size <= 0) throw new Error(`${asset.name} is unavailable`);
    this.#records.set(key, {
      userId: context.userId,
      cloudProjectId: context.cloudProjectId,
      assetId: asset.id,
      cloudAssetId: null,
      uploadId: null,
      projectDirectory: context.directory,
      sourcePath,
      managedSource: context.managedSources.has(asset.id),
      name: asset.name,
      bytes: info.size,
      uploadedBytes: 0,
      state: context.cloudAvailable ? "preparing" : "waiting-for-cloud",
      error: null,
      checksumSha256: null,
      sourceFingerprint: null,
    });
    if (context.cloudAvailable) this.#start(key);
  }

  #restartRecord(
    key: string,
    record: TransferRecord,
    managedSource: boolean,
    cloudAvailable: boolean,
  ): void {
    if (managedSource) record.managedSource = true;
    record.state = cloudAvailable ? "preparing" : "waiting-for-cloud";
    record.error = null;
    if (cloudAvailable) this.#start(key);
  }

  async retry(assetId: string): Promise<CloudTransferSnapshot[]> {
    const [key, record] = this.#activeRecord(assetId);
    if (
      !record ||
      (record.state !== "waiting-for-cloud" &&
        record.state !== "paused" &&
        record.state !== "failed")
    )
      throw new Error("This cloud transfer cannot be retried");
    if (this.#scheduler.has(key)) return this.snapshots();
    const account = await this.account.snapshot();
    if (account.status !== "signed-in" || account.cloudStorage !== true) {
      record.state = "waiting-for-cloud";
      record.error = null;
      await this.#persistAndEmit();
      return this.snapshots();
    }
    record.state = "preparing";
    record.error = null;
    this.#start(key);
    await this.#persist();
    this.#emit();
    return this.snapshots();
  }

  async cancel(assetId: string): Promise<CloudTransferSnapshot[]> {
    const [key, record] = this.#activeRecord(assetId);
    if (!record) return this.snapshots();
    this.#scheduler.cancel(key);
    if (record.uploadId && record.uploadedBytes < record.bytes)
      await this.#gateway.abortUpload(record.uploadId).catch(() => undefined);
    record.state = "paused";
    record.error = null;
    if (record.uploadedBytes < record.bytes) {
      record.uploadId = null;
      record.cloudAssetId = null;
      record.uploadedBytes = 0;
    }
    await this.#persist();
    this.#emit();
    return this.snapshots();
  }

  async trashAssets(cloudAssetIds: string[]): Promise<void> {
    await this.#assets.trash(cloudAssetIds);
  }

  async restoreAsset(cloudAssetId: string): Promise<void> {
    await this.#assets.restore(cloudAssetId);
  }

  async deleteAsset(cloudAssetId: string): Promise<void> {
    await this.#assets.delete(cloudAssetId);
  }

  async resumeAvailable(): Promise<void> {
    const account = await this.account.snapshot();
    if (account.status !== "signed-in" || !account.user || account.cloudStorage !== true) return;
    for (const [key, record] of this.#records) {
      if (
        record.userId === account.user.id &&
        record.projectDirectory === this.projects.directory &&
        (record.state === "waiting-for-cloud" || record.state === "paused") &&
        !this.#scheduler.has(key)
      ) {
        record.state = "preparing";
        record.error = null;
        this.#start(key);
      }
    }
    await this.#persistAndEmit();
  }

  #start(key: string): void {
    this.#scheduler.enqueue({
      key,
      run: (signal) => this.#run(key, signal),
      settled: async (error, aborted) => {
        if (!error || aborted) return;
        const record = this.#records.get(key);
        if (!record) return;
        const account = await this.account.snapshot();
        const unavailable = account.status !== "signed-in" || account.cloudStorage !== true;
        record.state = unavailable ? "waiting-for-cloud" : "failed";
        record.error = unavailable
          ? null
          : error instanceof Error
            ? error.message
            : "Cloud upload failed";
        await this.#persist();
        this.#emit();
        if (!unavailable)
          log.error(
            { err: error, operation: "upload", assetId: record.assetId },
            "Cloud media upload failed",
          );
      },
    });
  }

  async #run(key: string, signal: AbortSignal): Promise<void> {
    const record = this.#records.get(key);
    if (!record) return;
    await this.#uploadRunner.run(key, record, signal);
  }

  async #persistAndEmit(): Promise<void> {
    await this.#persist();
    this.#emit();
  }

  async #publishProgress(key: string): Promise<void> {
    const now = performance.now();
    const previous = this.#lastProgressPublication.get(key) ?? Number.NEGATIVE_INFINITY;
    if (now - previous < PROGRESS_PUBLICATION_INTERVAL_MS) return;
    this.#lastProgressPublication.set(key, now);
    await this.#persistAndEmit();
  }

  async #persist(): Promise<void> {
    await this.#repository.save(
      [...this.#records.values()].filter((record) => record.state !== "complete"),
    );
  }

  #emit(): void {
    this.events.transfersChanged(this.snapshots());
  }

  #emitProject(): void {
    this.events.projectChanged(this.projects.session());
  }

  #recordKey(record: { userId: string; projectDirectory: string; assetId: string }): string {
    return `${record.userId}\u0000${record.projectDirectory}\u0000${record.assetId}`;
  }

  #activeRecord(assetId: string): [string, TransferRecord | undefined] {
    const userId = this.account.requireCachedUser().id;
    const projectDirectory = this.projects.directory;
    if (!projectDirectory) throw new Error("Open a project before managing cloud transfers");
    const key = this.#recordKey({ userId, projectDirectory, assetId });
    return [key, this.#records.get(key)];
  }
}

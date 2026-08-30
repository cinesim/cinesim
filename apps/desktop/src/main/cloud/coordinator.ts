import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { AssetId, CloudAssetId } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { z } from "zod";
import type { CloudStorageUsage, CloudTransferSnapshot } from "../../shared/contracts";
import type { DesktopAccountService } from "../account/service";
import { fingerprintSource } from "../derived-media/source-fingerprint";
import type { DesktopProjectStore } from "../projects/project-store";
import { CloudStorageGateway } from "./gateway";
import {
  MAX_QUEUED_ASSETS,
  PROGRESS_PUBLICATION_INTERVAL_MS,
  SIGNED_URL_REFRESH_MARGIN_MS,
} from "./limits";
import { MultipartUploader } from "./multipart-uploader";
import { CloudOriginalCache } from "./original-cache";
import { CloudTransferRepository } from "./transfer-repository";
import type { TransferRecord } from "./transfer-repository";
import { CloudUploadScheduler } from "./upload-scheduler";
import { CloudAssetService } from "./asset-service";

const log = createCinesimLogger({ service: "cloud-media" });

const cloudProjectSchema = z.object({
  id: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
});

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".m4v": "video/x-m4v",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".flac": "audio/flac",
    }[extension] ?? "application/octet-stream"
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export class CloudMediaCoordinator {
  readonly #records = new Map<string, TransferRecord>();
  readonly #scheduler = new CloudUploadScheduler();
  readonly #downloadUrls = new Map<string, { url: string; bytes: number; expiresAt: number }>();
  readonly #lastProgressPublication = new Map<string, number>();
  readonly #gateway: CloudStorageGateway;
  readonly #uploader: MultipartUploader;
  readonly #repository: CloudTransferRepository;
  readonly #originalCache: CloudOriginalCache;
  readonly #assets: CloudAssetService;

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
    this.#originalCache = new CloudOriginalCache(projects, (cloudAssetId) =>
      this.#signedDownload(cloudAssetId),
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

  async readOriginal(cloudAssetId: string, request: Request): Promise<Response> {
    const signed = await this.#signedDownload(cloudAssetId);
    if (request.method === "HEAD")
      return new Response(null, {
        headers: {
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
          "Content-Length": String(signed.bytes),
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    const headers = new Headers();
    const range = request.headers.get("range");
    if (range) headers.set("range", range);
    const response = await fetch(signed.url, { headers, signal: request.signal });
    if (!response.ok && response.status !== 206) {
      if (response.status === 401 || response.status === 403)
        this.#downloadUrls.delete(cloudAssetId);
      throw new Error(`Cloud original read failed (${response.status})`);
    }
    const forwarded = new Headers(response.headers);
    forwarded.set("Access-Control-Allow-Origin", "*");
    forwarded.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers: forwarded });
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
    if (
      assetIds.length === 0 ||
      assetIds.length > MAX_QUEUED_ASSETS ||
      assetIds.some((id) => !/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))
    )
      throw new Error("Invalid cloud storage request");
    const requestedAssetIds = new Set(assetIds);
    if (managedSourceAssetIds.some((assetId) => !requestedAssetIds.has(assetId)))
      throw new Error("Invalid managed cloud storage request");
    const managedSources = new Set(managedSourceAssetIds);
    const project = this.projects.project;
    const directory = this.projects.directory;
    if (!project || !directory) throw new Error("Open a project before storing media in cloud");
    if (!project.cloudProjectId) throw new Error("This project is not registered to an account");
    const user = this.account.requireCachedUser();
    const account = await this.account.snapshot();
    const cloudAvailable = account.status === "signed-in" && account.cloudStorage === true;
    const assets = [...new Set(assetIds)].map((assetId) => {
      const asset = project.assets.find((candidate) => candidate.id === assetId);
      if (!asset) throw new Error("The selected media is no longer in this project");
      if (asset.kind === "image")
        throw new Error("Cloud originals for still images are not supported in this build");
      return asset;
    });
    for (const asset of assets) {
      if (asset.source.kind === "cloud") continue;
      const key = this.#recordKey({
        userId: user.id,
        projectDirectory: directory,
        assetId: asset.id,
      });
      if (this.#scheduler.has(key)) continue;
      const existing = this.#records.get(key);
      if (
        existing &&
        (existing.state === "waiting-for-cloud" ||
          existing.state === "paused" ||
          existing.state === "failed")
      ) {
        if (managedSources.has(asset.id)) existing.managedSource = true;
        existing.state = cloudAvailable ? "preparing" : "waiting-for-cloud";
        existing.error = null;
        if (cloudAvailable) this.#start(key);
        continue;
      }
      const info = await stat(asset.source.path);
      if (!info.isFile() || info.size <= 0) throw new Error(`${asset.name} is unavailable`);
      this.#records.set(key, {
        userId: user.id,
        cloudProjectId: project.cloudProjectId,
        assetId: asset.id,
        cloudAssetId: null,
        uploadId: null,
        projectDirectory: directory,
        sourcePath: asset.source.path,
        managedSource: managedSources.has(asset.id),
        name: asset.name,
        bytes: info.size,
        uploadedBytes: 0,
        state: cloudAvailable ? "preparing" : "waiting-for-cloud",
        error: null,
        checksumSha256: null,
        sourceFingerprint: null,
      });
      if (cloudAvailable) this.#start(key);
    }
    await this.#persist();
    this.#emit();
    return this.snapshots();
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
    const record = this.#records.get(key)!;
    const assetId = record.assetId;
    if (this.account.requireCachedUser().id !== record.userId)
      throw new Error("Sign in to the account that owns this transfer");
    if (this.projects.directory !== record.projectDirectory)
      throw new Error("Open the source project to resume this upload");
    const project = this.projects.project!;
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset || asset.source.kind !== "local" || asset.source.path !== record.sourcePath)
      throw new Error("The source media changed after this upload was queued");

    await this.projects.derivedMedia.queuePerception([asset.id]);
    await this.projects.derivedMedia.waitForPerception(asset.id, signal);
    if (signal.aborted) return;
    await this.projects.derivedMedia.queueProxy(asset.id);
    const [fingerprint, checksum] = await Promise.all([
      fingerprintSource(record.sourcePath),
      sha256File(record.sourcePath),
    ]);
    if (signal.aborted) return;
    if (fingerprint.size !== record.bytes)
      throw new Error("The source media changed after this upload was queued");
    if (
      record.sourceFingerprint &&
      (record.sourceFingerprint.size !== fingerprint.size ||
        Math.round(record.sourceFingerprint.mtimeMs) !== Math.round(fingerprint.mtimeMs) ||
        record.sourceFingerprint.edgeHash !== fingerprint.edgeHash)
    )
      throw new Error("The source media changed since this upload was paused");
    if (record.checksumSha256 && record.checksumSha256 !== checksum)
      throw new Error("The source media changed since this upload was paused");
    record.sourceFingerprint = fingerprint;
    record.checksumSha256 = checksum;

    if (project.cloudProjectId !== record.cloudProjectId)
      throw new Error("The project account registration changed after this upload was queued");
    const cloudProject = cloudProjectSchema.parse(
      await this.account.registerProject({
        cloudProjectId: record.cloudProjectId,
        clientProjectId: project.id,
        name: project.name,
      }),
    );

    let upload = record.uploadId
      ? await this.#gateway.upload(record.uploadId).catch(() => null)
      : null;
    if (!upload) {
      record.uploadId = null;
      record.cloudAssetId = null;
      record.uploadedBytes = 0;
      upload = await this.#gateway.createUpload({
        cloudProjectId: cloudProject.id,
        clientAssetId: asset.id,
        name: asset.name,
        kind: asset.kind,
        contentType: contentType(record.name),
        bytes: record.bytes,
        checksumSha256: checksum,
        sourceFingerprint: fingerprint,
      });
    }
    if (Date.parse(upload.expiresAt) <= Date.now()) throw new Error("Cloud upload has expired");
    record.cloudAssetId = upload.cloudAssetId;
    record.uploadId = upload.id;
    record.state = "uploading";
    record.uploadedBytes = upload.parts.reduce((total, part) => total + part.bytes, 0);
    await this.#persistAndEmit();

    await this.#uploader.upload({
      upload,
      sourcePath: record.sourcePath,
      sourceBytes: record.bytes,
      signal,
      onPartComplete: async (bytes) => {
        record.uploadedBytes += bytes;
        await this.#publishProgress(key);
      },
    });
    if (signal.aborted) return;
    record.uploadedBytes = record.bytes;
    await this.#persistAndEmit();
    await this.#gateway.completeUpload(upload.id, signal);
    record.state = "waiting-for-proxy";
    record.uploadedBytes = record.bytes;
    await this.#persistAndEmit();

    await this.projects.derivedMedia.waitForProxy(asset.id, signal);
    if (signal.aborted) return;
    const current = this.projects.project?.assets.find((candidate) => candidate.id === asset.id);
    if (!current || current.source.kind !== "local" || current.source.path !== record.sourcePath)
      throw new Error("The source media changed before cloud storage was finalized");
    await this.projects.execute({
      type: "asset.setSource",
      assetId: asset.id as AssetId,
      source: { kind: "cloud", cloudAssetId: upload.cloudAssetId as CloudAssetId },
    });
    this.#emitProject();
    if (record.managedSource) await this.#originalCache.removeManagedSource(record);
    record.state = "complete";
    await this.#persistAndEmit();
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

  async #signedDownload(
    cloudAssetId: string,
  ): Promise<{ url: string; bytes: number; expiresAt: number }> {
    let signed = this.#downloadUrls.get(cloudAssetId);
    if (!signed || signed.expiresAt <= Date.now() + SIGNED_URL_REFRESH_MARGIN_MS) {
      signed = await this.#gateway.download(cloudAssetId);
      this.#downloadUrls.set(cloudAssetId, signed);
    }
    return signed;
  }
}

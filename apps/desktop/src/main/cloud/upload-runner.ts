import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { extname } from "node:path";
import type { Asset, AssetId, CloudAssetId, Project } from "@cinesim/core";
import { z } from "zod";
import type { SourceFingerprint } from "../../shared/contracts";
import type { DesktopAccountService } from "../account/service";
import { fingerprintSource } from "../derived-media/source-fingerprint";
import type { DesktopProjectStore } from "../projects/project-store";
import type { CloudStorageGateway, CloudUpload } from "./gateway";
import type { MultipartUploader } from "./multipart-uploader";
import type { CloudOriginalCache } from "./original-cache";
import type { TransferRecord } from "./transfer-repository";

const cloudProjectSchema = z.object({
  id: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
});

interface TransferSource {
  project: Project;
  asset: Asset;
}

interface PreparedSource {
  fingerprint: SourceFingerprint;
  checksum: string;
}

export interface CloudUploadRunnerCallbacks {
  persistAndEmit(): Promise<void>;
  publishProgress(key: string): Promise<void>;
  projectChanged(): void;
}

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

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return (
    left.size === right.size &&
    Math.round(left.mtimeMs) === Math.round(right.mtimeMs) &&
    left.edgeHash === right.edgeHash
  );
}

function validatePreparedSource(
  record: TransferRecord,
  fingerprint: SourceFingerprint,
  checksum: string,
): void {
  if (fingerprint.size !== record.bytes) {
    throw new Error("The source media changed after this upload was queued");
  }
  if (record.sourceFingerprint && !sameFingerprint(record.sourceFingerprint, fingerprint)) {
    throw new Error("The source media changed since this upload was paused");
  }
  if (record.checksumSha256 && record.checksumSha256 !== checksum) {
    throw new Error("The source media changed since this upload was paused");
  }
}

export class CloudUploadRunner {
  constructor(
    private readonly account: DesktopAccountService,
    private readonly projects: DesktopProjectStore,
    private readonly gateway: CloudStorageGateway,
    private readonly uploader: MultipartUploader,
    private readonly originalCache: CloudOriginalCache,
    private readonly callbacks: CloudUploadRunnerCallbacks,
  ) {}

  async run(key: string, record: TransferRecord, signal: AbortSignal): Promise<void> {
    const { project, asset } = this.#requireTransferSource(record);
    const prepared = await this.#prepareSource(record, asset, signal);
    if (!prepared) return;
    const cloudProjectId = await this.#registeredCloudProjectId(record, project);
    const upload = await this.#findOrCreateUpload(record, asset, cloudProjectId, prepared);
    await this.#uploadOriginal(key, record, upload, signal);
    if (signal.aborted) return;
    await this.#completeUpload(record, upload, signal);
    await this.#finalizeCloudSource(record, asset, upload, signal);
  }

  #requireTransferSource(record: TransferRecord): TransferSource {
    if (this.account.requireCachedUser().id !== record.userId) {
      throw new Error("Sign in to the account that owns this transfer");
    }
    if (this.projects.directory !== record.projectDirectory) {
      throw new Error("Open the source project to resume this upload");
    }

    const project = this.projects.project;
    if (!project) throw new Error("The source media changed after this upload was queued");
    const asset = project.assets.find((candidate) => candidate.id === record.assetId);
    if (!asset || asset.source.kind !== "local" || asset.source.path !== record.sourcePath) {
      throw new Error("The source media changed after this upload was queued");
    }
    return { project, asset };
  }

  async #prepareSource(
    record: TransferRecord,
    asset: Asset,
    signal: AbortSignal,
  ): Promise<PreparedSource | null> {
    await this.projects.derivedMedia.queuePerception([asset.id]);
    await this.projects.derivedMedia.waitForPerception(asset.id, signal);
    if (signal.aborted) return null;
    await this.projects.derivedMedia.queueProxy(asset.id);
    const [fingerprint, checksum] = await Promise.all([
      fingerprintSource(record.sourcePath),
      sha256File(record.sourcePath),
    ]);
    if (signal.aborted) return null;
    validatePreparedSource(record, fingerprint, checksum);
    record.sourceFingerprint = fingerprint;
    record.checksumSha256 = checksum;
    return { fingerprint, checksum };
  }

  async #registeredCloudProjectId(record: TransferRecord, project: Project): Promise<string> {
    if (project.cloudProjectId !== record.cloudProjectId) {
      throw new Error("The project account registration changed after this upload was queued");
    }
    const cloudProject = cloudProjectSchema.parse(
      await this.account.registerProject({
        cloudProjectId: record.cloudProjectId,
        clientProjectId: project.id,
        name: project.name,
      }),
    );
    return cloudProject.id;
  }

  async #findOrCreateUpload(
    record: TransferRecord,
    asset: Asset,
    cloudProjectId: string,
    prepared: PreparedSource,
  ): Promise<CloudUpload> {
    const existing = record.uploadId
      ? await this.gateway.upload(record.uploadId).catch(() => null)
      : null;
    if (existing) return existing;

    record.uploadId = null;
    record.cloudAssetId = null;
    record.uploadedBytes = 0;
    return this.gateway.createUpload({
      cloudProjectId,
      clientAssetId: asset.id,
      name: asset.name,
      kind: asset.kind,
      contentType: contentType(record.name),
      bytes: record.bytes,
      checksumSha256: prepared.checksum,
      sourceFingerprint: prepared.fingerprint,
    });
  }

  async #uploadOriginal(
    key: string,
    record: TransferRecord,
    upload: CloudUpload,
    signal: AbortSignal,
  ): Promise<void> {
    if (Date.parse(upload.expiresAt) <= Date.now()) throw new Error("Cloud upload has expired");
    record.cloudAssetId = upload.cloudAssetId;
    record.uploadId = upload.id;
    record.state = "uploading";
    record.uploadedBytes = upload.parts.reduce((total, part) => total + part.bytes, 0);
    await this.callbacks.persistAndEmit();

    await this.uploader.upload({
      upload,
      sourcePath: record.sourcePath,
      sourceBytes: record.bytes,
      signal,
      onPartComplete: async (bytes) => {
        record.uploadedBytes += bytes;
        await this.callbacks.publishProgress(key);
      },
    });
  }

  async #completeUpload(
    record: TransferRecord,
    upload: CloudUpload,
    signal: AbortSignal,
  ): Promise<void> {
    record.uploadedBytes = record.bytes;
    await this.callbacks.persistAndEmit();
    await this.gateway.completeUpload(upload.id, signal);
    record.state = "waiting-for-proxy";
    record.uploadedBytes = record.bytes;
    await this.callbacks.persistAndEmit();
  }

  async #finalizeCloudSource(
    record: TransferRecord,
    asset: Asset,
    upload: CloudUpload,
    signal: AbortSignal,
  ): Promise<void> {
    await this.projects.derivedMedia.waitForProxy(asset.id, signal);
    if (signal.aborted) return;
    const current = this.projects.project?.assets.find((candidate) => candidate.id === asset.id);
    if (!current || current.source.kind !== "local" || current.source.path !== record.sourcePath) {
      throw new Error("The source media changed before cloud storage was finalized");
    }
    await this.projects.execute({
      type: "asset.setSource",
      assetId: asset.id as AssetId,
      source: { kind: "cloud", cloudAssetId: upload.cloudAssetId as CloudAssetId },
    });
    this.callbacks.projectChanged();
    if (record.managedSource) await this.originalCache.removeManagedSource(record);
    record.state = "complete";
    await this.callbacks.persistAndEmit();
  }
}

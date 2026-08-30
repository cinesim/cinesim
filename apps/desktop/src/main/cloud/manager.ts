import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BrowserWindow } from "electron";
import type { AssetId, CloudAssetId } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { z } from "zod";
import type { CloudStorageUsage, CloudTransferSnapshot } from "../../shared/contracts";
import type { DesktopAccountService } from "../account/service";
import { fingerprintSource } from "../derived-media/source-fingerprint";
import type { DesktopProjectStore } from "../projects/project-store";
import { eventChannels } from "../../shared/contracts/channels";

const log = createCinesimLogger({ service: "cloud-media" });
const MAX_QUEUED_ASSETS = 100;
const PART_CONCURRENCY = 3;

const transferRecordSchema = z.object({
  userId: z.string().min(1),
  cloudProjectId: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
  assetId: z.string(),
  cloudAssetId: z.string().nullable(),
  uploadId: z.string().nullable(),
  projectDirectory: z.string(),
  sourcePath: z.string(),
  managedSource: z.boolean().default(false),
  name: z.string(),
  bytes: z.number().int().positive(),
  uploadedBytes: z.number().int().nonnegative(),
  state: z.enum([
    "waiting-for-cloud",
    "preparing",
    "uploading",
    "waiting-for-proxy",
    "paused",
    "failed",
    "complete",
  ]),
  error: z.string().nullable(),
  checksumSha256: z.string().nullable(),
  sourceFingerprint: z
    .object({ size: z.number(), mtimeMs: z.number(), edgeHash: z.string() })
    .nullable(),
});

type TransferRecord = z.infer<typeof transferRecordSchema>;

const uploadSchema = z.object({
  id: z.string().regex(/^cloud_upload_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
  cloudAssetId: z.string().regex(/^cloud_asset_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
  partSize: z.number().int().positive(),
  bytes: z.number().int().positive(),
  parts: z.array(
    z.object({ partNumber: z.number().int().positive(), etag: z.string(), bytes: z.number() }),
  ),
});

const bytesSchema = z.number().int().nonnegative().safe();
const cloudStorageUsageSchema = z.object({
  includedBytes: bytesSchema,
  addonBytes: bytesSchema,
  usedBytes: bytesSchema,
  reservedBytes: bytesSchema,
  addonOptionsBytes: z.array(bytesSchema).max(32),
  projects: z.array(
    z.object({
      id: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
      clientProjectId: z.string(),
      name: z.string(),
      usedBytes: bytesSchema,
      reservedBytes: bytesSchema,
      assets: z.array(
        z.object({
          id: z.string().regex(/^cloud_asset_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
          clientAssetId: z.string(),
          name: z.string(),
          kind: z.enum(["video", "audio", "image"]),
          bytes: bytesSchema,
          state: z.enum(["preparing", "uploading", "ready", "failed", "trashed"]),
          trashedAt: z.string().nullable(),
        }),
      ),
    }),
  ),
});

const cloudProjectSchema = z.object({
  id: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
});

const signedR2UrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname.endsWith(".r2.cloudflarestorage.com");
}, "Cloud storage returned an invalid signed URL");

const signedPartsSchema = z.object({
  parts: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      url: signedR2UrlSchema,
    }),
  ),
});

const downloadSchema = z.object({ url: signedR2UrlSchema, bytes: bytesSchema });

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

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export class CloudMediaManager {
  readonly #records = new Map<string, TransferRecord>();
  readonly #running = new Map<string, AbortController>();
  readonly #downloadUrls = new Map<string, { url: string; bytes: number; expiresAt: number }>();
  readonly #downloadOperations = new Map<string, Promise<void>>();
  #persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly journalPath: string,
    private readonly account: DesktopAccountService,
    private readonly projects: DesktopProjectStore,
  ) {}

  async load(): Promise<void> {
    const source = await readFile(this.journalPath, "utf8").catch(() => "[]");
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      value = null;
    }
    const parsed = z.array(transferRecordSchema).safeParse(value);
    if (!parsed.success) {
      log.warn({ operation: "journal-load" }, "Ignored an invalid cloud transfer journal");
      return;
    }
    for (const record of parsed.data)
      this.#records.set(this.#recordKey(record), {
        ...record,
        state:
          record.state === "preparing" ||
          record.state === "uploading" ||
          record.state === "waiting-for-proxy"
            ? "paused"
            : record.state,
      });
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
    return cloudStorageUsageSchema.parse(
      await json<unknown>(await this.account.authenticatedFetch("/api/v1/cloud/usage")),
    );
  }

  async configureAddon(addonBytes: number): Promise<CloudStorageUsage> {
    if (!Number.isSafeInteger(addonBytes) || addonBytes < 0)
      throw new Error("Invalid storage allowance");
    return cloudStorageUsageSchema.parse(
      await json<unknown>(
        await this.account.authenticatedFetch("/api/v1/cloud/usage", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ addonBytes }),
        }),
      ),
    );
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
    const project = this.projects.project;
    if (!project || !this.projects.directory) return [];
    const downloaded = await Promise.all(
      project.assets
        .filter((asset) => asset.source.kind === "cloud")
        .map(async (asset) => ((await this.downloadedOriginalPath(asset.id)) ? asset.id : null)),
    );
    return downloaded
      .flatMap((assetId) => (assetId ? [assetId] : []))
      .toSorted((left, right) => left.localeCompare(right));
  }

  async downloadedOriginalPath(assetId: string): Promise<string | null> {
    const asset = this.projects.project?.assets.find((candidate) => candidate.id === assetId);
    if (!asset || asset.source.kind !== "cloud" || !this.projects.directory) return null;
    const directory = await this.#originalsDirectory(this.projects.directory, false);
    if (!directory) return null;
    const path = join(directory, asset.id);
    const info = await lstat(path).catch(() => null);
    return info?.isFile() && info.size > 0 ? path : null;
  }

  async keepDownloaded(assetId: string): Promise<string[]> {
    const project = this.projects.project;
    const projectDirectory = this.projects.directory;
    if (!project || !projectDirectory)
      throw new Error("Open a project before downloading a cloud original");
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset || asset.source.kind !== "cloud")
      throw new Error("Only cloud-backed originals can be kept downloaded");
    if (await this.downloadedOriginalPath(asset.id)) return this.downloadedOriginals();

    const originalsDirectory = await this.#originalsDirectory(projectDirectory, true);
    if (!originalsDirectory) throw new Error("The downloaded originals directory is unavailable");
    const destination = join(originalsDirectory, asset.id);
    const existing = this.#downloadOperations.get(destination);
    if (existing) await existing;
    else {
      const operation = this.#downloadOriginal(asset.source.cloudAssetId, destination);
      this.#downloadOperations.set(destination, operation);
      try {
        await operation;
      } finally {
        if (this.#downloadOperations.get(destination) === operation)
          this.#downloadOperations.delete(destination);
      }
    }
    return this.downloadedOriginals();
  }

  async #downloadOriginal(cloudAssetId: string, destination: string): Promise<void> {
    const signed = await this.#signedDownload(cloudAssetId);
    const response = await fetch(signed.url);
    if (!response.ok || !response.body)
      throw new Error(`Cloud original download failed (${response.status})`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      const downloaded = await stat(temporary);
      if (!downloaded.isFile() || downloaded.size !== signed.bytes)
        throw new Error("The downloaded original did not match its cloud object size");
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async removeDownload(assetId: string): Promise<string[]> {
    const projectDirectory = this.projects.directory;
    const asset = this.projects.project?.assets.find((candidate) => candidate.id === assetId);
    if (!projectDirectory || !asset || asset.source.kind !== "cloud")
      throw new Error("Only cloud-backed originals can remove a local download");
    const originalsDirectory = await this.#originalsDirectory(projectDirectory, false);
    if (originalsDirectory) {
      const destination = join(originalsDirectory, asset.id);
      await this.#downloadOperations.get(destination);
      await rm(destination, { force: true });
    }
    return this.downloadedOriginals();
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
      if (this.#running.has(key)) continue;
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
    if (this.#running.has(key)) return this.snapshots();
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
    this.#running.get(key)?.abort();
    if (record.uploadId && record.uploadedBytes < record.bytes)
      await this.account
        .authenticatedFetch(`/api/v1/cloud/uploads/${encodeURIComponent(record.uploadId)}`, {
          method: "DELETE",
        })
        .catch(() => undefined);
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
    await Promise.all(
      cloudAssetIds.map((id) =>
        this.account.authenticatedFetch(`/api/v1/cloud/assets/${encodeURIComponent(id)}/trash`, {
          method: "POST",
        }),
      ),
    );
  }

  async restoreAsset(cloudAssetId: string): Promise<void> {
    await this.account.authenticatedFetch(
      `/api/v1/cloud/assets/${encodeURIComponent(cloudAssetId)}/restore`,
      { method: "POST" },
    );
  }

  async deleteAsset(cloudAssetId: string): Promise<void> {
    await this.account.authenticatedFetch(
      `/api/v1/cloud/assets/${encodeURIComponent(cloudAssetId)}`,
      { method: "DELETE" },
    );
  }

  async resumeAvailable(): Promise<void> {
    const account = await this.account.snapshot();
    if (account.status !== "signed-in" || !account.user || account.cloudStorage !== true) return;
    for (const [key, record] of this.#records) {
      if (
        record.userId === account.user.id &&
        record.projectDirectory === this.projects.directory &&
        (record.state === "waiting-for-cloud" || record.state === "paused") &&
        !this.#running.has(key)
      ) {
        record.state = "preparing";
        record.error = null;
        this.#start(key);
      }
    }
    await this.#persistAndEmit();
  }

  #start(key: string): void {
    const controller = new AbortController();
    this.#running.set(key, controller);
    void this.#run(key, controller.signal)
      .catch(async (error: unknown) => {
        const record = this.#records.get(key);
        if (!record) return;
        if (controller.signal.aborted) return;
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
      })
      .finally(() => {
        if (this.#running.get(key) === controller) this.#running.delete(key);
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

    let resumeResponse: Response | null = null;
    if (record.uploadId)
      resumeResponse = await this.account
        .authenticatedFetch(`/api/v1/cloud/uploads/${encodeURIComponent(record.uploadId)}`)
        .catch(() => null);
    if (!resumeResponse) {
      record.uploadId = null;
      record.cloudAssetId = null;
      record.uploadedBytes = 0;
    }
    const upload = uploadSchema.parse(
      await json<unknown>(
        resumeResponse
          ? resumeResponse
          : await this.account.authenticatedFetch("/api/v1/cloud/uploads", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                cloudProjectId: cloudProject.id,
                clientAssetId: asset.id,
                name: asset.name,
                kind: asset.kind,
                contentType: contentType(record.name),
                bytes: record.bytes,
                checksumSha256: checksum,
                sourceFingerprint: fingerprint,
              }),
            }),
      ),
    );
    record.cloudAssetId = upload.cloudAssetId;
    record.uploadId = upload.id;
    record.state = "uploading";
    record.uploadedBytes = upload.parts.reduce((total, part) => total + part.bytes, 0);
    await this.#persistAndEmit();

    const completeParts = new Set(upload.parts.map((part) => part.partNumber));
    const partCount = Math.ceil(record.bytes / upload.partSize);
    const handle = await open(record.sourcePath, "r");
    try {
      for (let first = 1; first <= partCount; first += PART_CONCURRENCY) {
        const partNumbers = Array.from(
          { length: Math.min(PART_CONCURRENCY, partCount - first + 1) },
          (_, index) => first + index,
        ).filter((partNumber) => !completeParts.has(partNumber));
        if (partNumbers.length === 0) continue;
        const signed = signedPartsSchema.parse(
          await json<unknown>(
            await this.account.authenticatedFetch(
              `/api/v1/cloud/uploads/${encodeURIComponent(upload.id)}/parts/sign`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ partNumbers }),
                signal,
              },
            ),
          ),
        );
        await Promise.all(
          signed.parts.map(async ({ partNumber, url }) => {
            const position = (partNumber - 1) * upload.partSize;
            const length = Math.min(upload.partSize, record.bytes - position);
            const buffer = Buffer.allocUnsafe(length);
            const read = await handle.read(buffer, 0, length, position);
            if (read.bytesRead !== length)
              throw new Error("The source media changed during upload");
            const response = await fetch(url, { method: "PUT", body: buffer, signal });
            if (!response.ok) throw new Error(`Cloud part upload failed (${response.status})`);
            const etag = response.headers.get("etag");
            if (!etag) throw new Error("Cloud part upload did not return an ETag");
            await this.account.authenticatedFetch(
              `/api/v1/cloud/uploads/${encodeURIComponent(upload.id)}/parts/${partNumber}`,
              {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ etag, bytes: length }),
                signal,
              },
            );
            record.uploadedBytes += length;
            await this.#persistAndEmit();
          }),
        );
      }
    } finally {
      await handle.close();
    }
    if (signal.aborted) return;
    await this.account.authenticatedFetch(
      `/api/v1/cloud/uploads/${encodeURIComponent(upload.id)}/complete`,
      { method: "POST", signal },
    );
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
    if (record.managedSource) await this.#removeManagedSource(record);
    record.state = "complete";
    await this.#persistAndEmit();
  }

  async #persistAndEmit(): Promise<void> {
    await this.#persist();
    this.#emit();
  }

  async #persist(): Promise<void> {
    const operation = this.#persistQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.journalPath), { recursive: true });
        const temporary = `${this.journalPath}.tmp`;
        const persisted = [...this.#records.values()].filter(
          (record) => record.state !== "complete",
        );
        await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
        await rename(temporary, this.journalPath);
      });
    this.#persistQueue = operation;
    await operation;
  }

  #emit(): void {
    const snapshot = this.snapshots();
    for (const target of BrowserWindow?.getAllWindows?.() ?? [])
      target.webContents.send(eventChannels.cloudTransfersChanged, snapshot);
  }

  #emitProject(): void {
    const session = this.projects.session();
    for (const target of BrowserWindow?.getAllWindows?.() ?? [])
      target.webContents.send(eventChannels.projectChanged, session);
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
    if (!signed || signed.expiresAt <= Date.now()) {
      const value = downloadSchema.parse(
        await json<unknown>(
          await this.account.authenticatedFetch(
            `/api/v1/cloud/assets/${encodeURIComponent(cloudAssetId)}/download`,
            { method: "POST" },
          ),
        ),
      );
      signed = { ...value, expiresAt: Date.now() + 4 * 60_000 };
      this.#downloadUrls.set(cloudAssetId, signed);
    }
    return signed;
  }

  async #originalsDirectory(projectDirectory: string, create: boolean): Promise<string | null> {
    const videoDirectory = join(projectDirectory, ".video");
    const originalsDirectory = join(videoDirectory, "originals");
    if (create) await mkdir(videoDirectory, { recursive: true });
    const videoInfo = await lstat(videoDirectory).catch(() => null);
    if (!videoInfo) return null;
    if (videoInfo.isSymbolicLink() || !videoInfo.isDirectory())
      throw new Error("The downloaded originals directory must stay inside .video");
    if (create) await mkdir(originalsDirectory, { recursive: true });
    const originalsInfo = await lstat(originalsDirectory).catch(() => null);
    if (!originalsInfo) return null;
    if (originalsInfo.isSymbolicLink() || !originalsInfo.isDirectory())
      throw new Error("The downloaded originals directory must stay inside .video");
    return originalsDirectory;
  }

  async #removeManagedSource(record: TransferRecord): Promise<void> {
    try {
      const originalsDirectory = await this.#originalsDirectory(record.projectDirectory, false);
      if (!originalsDirectory || record.sourcePath !== join(originalsDirectory, record.assetId)) {
        log.warn(
          { operation: "managed-source-cleanup", assetId: record.assetId },
          "Retained a managed upload source outside its expected disposable path",
        );
        return;
      }
      const info = await lstat(record.sourcePath).catch(() => null);
      if (!info) return;
      if (info.isSymbolicLink() || !info.isFile()) {
        log.warn(
          { operation: "managed-source-cleanup", assetId: record.assetId },
          "Retained a managed upload source that was no longer a regular file",
        );
        return;
      }
      await rm(record.sourcePath, { force: true });
    } catch (error) {
      log.warn(
        { err: error, operation: "managed-source-cleanup", assetId: record.assetId },
        "Cloud upload completed but its disposable staging copy was retained",
      );
    }
  }
}

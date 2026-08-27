import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { BrowserWindow, shell } from "electron";
import type { AssetId, CloudAssetId, CloudProjectId } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { z } from "zod";
import type { CloudStorageUsage, CloudTransferSnapshot } from "../../shared/api";
import type { DesktopAccountService } from "../account/service";
import { fingerprintSource } from "../derived-media/source-fingerprint";
import type { DesktopProjectStore } from "../projects/project-store";

const log = createCinesimLogger({ service: "cloud-media" });
const MAX_QUEUED_ASSETS = 100;
const PART_CONCURRENCY = 3;

const transferRecordSchema = z.object({
  assetId: z.string(),
  cloudAssetId: z.string().nullable(),
  uploadId: z.string().nullable(),
  projectDirectory: z.string(),
  sourcePath: z.string(),
  name: z.string(),
  bytes: z.number().int().positive(),
  uploadedBytes: z.number().int().nonnegative(),
  state: z.enum(["preparing", "uploading", "waiting-for-proxy", "paused", "failed", "complete"]),
  error: z.string().nullable(),
  checksumSha256: z.string().nullable(),
  sourceFingerprint: z
    .object({ size: z.number(), mtimeMs: z.number(), edgeHash: z.string() })
    .nullable(),
});

type TransferRecord = z.infer<typeof transferRecordSchema>;

const uploadSchema = z.object({
  id: z.string(),
  cloudAssetId: z.string(),
  partSize: z.number().int().positive(),
  bytes: z.number().int().positive(),
  parts: z.array(
    z.object({ partNumber: z.number().int().positive(), etag: z.string(), bytes: z.number() }),
  ),
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

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export class CloudMediaManager {
  readonly #records = new Map<string, TransferRecord>();
  readonly #running = new Map<string, AbortController>();
  readonly #downloadUrls = new Map<string, { url: string; bytes: number; expiresAt: number }>();
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
      this.#records.set(record.assetId, {
        ...record,
        state: record.state === "preparing" ? "paused" : record.state,
      });
  }

  snapshots(): CloudTransferSnapshot[] {
    return [...this.#records.values()]
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
    return json<CloudStorageUsage>(await this.account.authenticatedFetch("/api/v1/cloud/usage"));
  }

  async readOriginal(cloudAssetId: string, request: Request): Promise<Response> {
    let signed = this.#downloadUrls.get(cloudAssetId);
    if (!signed || signed.expiresAt <= Date.now()) {
      const value = await json<{ url: string; bytes: number }>(
        await this.account.authenticatedFetch(
          `/api/v1/cloud/assets/${encodeURIComponent(cloudAssetId)}/download`,
          { method: "POST" },
        ),
      );
      signed = { ...value, expiresAt: Date.now() + 4 * 60_000 };
      this.#downloadUrls.set(cloudAssetId, signed);
    }
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

  async queue(assetIds: string[]): Promise<CloudTransferSnapshot[]> {
    if (
      assetIds.length === 0 ||
      assetIds.length > MAX_QUEUED_ASSETS ||
      assetIds.some((id) => !/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))
    )
      throw new Error("Invalid cloud storage request");
    const project = this.projects.project;
    const directory = this.projects.directory;
    if (!project || !directory) throw new Error("Open a project before storing media in cloud");
    const assets = [...new Set(assetIds)].map((assetId) => {
      const asset = project.assets.find((candidate) => candidate.id === assetId);
      if (!asset) throw new Error("The selected media is no longer in this project");
      if (asset.kind === "image")
        throw new Error("Cloud originals for still images are not supported in this build");
      return asset;
    });
    for (const asset of assets) {
      if (asset.source.kind === "cloud") continue;
      if (this.#running.has(asset.id)) continue;
      const info = await stat(asset.source.path);
      if (!info.isFile() || info.size <= 0) throw new Error(`${asset.name} is unavailable`);
      this.#records.set(asset.id, {
        assetId: asset.id,
        cloudAssetId: null,
        uploadId: null,
        projectDirectory: directory,
        sourcePath: asset.source.path,
        name: asset.name,
        bytes: info.size,
        uploadedBytes: 0,
        state: "preparing",
        error: null,
        checksumSha256: null,
        sourceFingerprint: null,
      });
      this.#start(asset.id);
    }
    await this.#persist();
    this.#emit();
    return this.snapshots();
  }

  async retry(assetId: string): Promise<CloudTransferSnapshot[]> {
    const record = this.#records.get(assetId);
    if (!record || (record.state !== "paused" && record.state !== "failed"))
      throw new Error("This cloud transfer cannot be retried");
    record.state = "preparing";
    record.error = null;
    this.#start(assetId);
    await this.#persist();
    this.#emit();
    return this.snapshots();
  }

  async cancel(assetId: string): Promise<CloudTransferSnapshot[]> {
    const record = this.#records.get(assetId);
    if (!record) return this.snapshots();
    this.#running.get(assetId)?.abort();
    if (record.uploadId)
      await this.account
        .authenticatedFetch(`/api/v1/cloud/uploads/${encodeURIComponent(record.uploadId)}`, {
          method: "DELETE",
        })
        .catch(() => undefined);
    record.state = "paused";
    record.error = null;
    record.uploadId = null;
    record.cloudAssetId = null;
    record.uploadedBytes = 0;
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

  #start(assetId: string): void {
    const controller = new AbortController();
    this.#running.set(assetId, controller);
    void this.#run(assetId, controller.signal)
      .catch(async (error: unknown) => {
        const record = this.#records.get(assetId);
        if (!record) return;
        if (controller.signal.aborted) return;
        record.state = "failed";
        record.error = error instanceof Error ? error.message : "Cloud upload failed";
        await this.#persist();
        this.#emit();
        log.error({ err: error, operation: "upload", assetId }, "Cloud media upload failed");
      })
      .finally(() => this.#running.delete(assetId));
  }

  async #run(assetId: string, signal: AbortSignal): Promise<void> {
    const record = this.#records.get(assetId)!;
    if (this.projects.directory !== record.projectDirectory)
      throw new Error("Open the source project to resume this upload");
    const project = this.projects.project!;
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset || asset.source.kind !== "local" || asset.source.path !== record.sourcePath)
      throw new Error("The source media changed after this upload was queued");

    await this.projects.derivedMedia.queueProxy(asset.id);
    const [fingerprint, checksum] = await Promise.all([
      fingerprintSource(record.sourcePath),
      sha256File(record.sourcePath),
    ]);
    if (signal.aborted) return;
    if (fingerprint.size !== record.bytes)
      throw new Error("The source media changed after this upload was queued");
    record.sourceFingerprint = fingerprint;
    record.checksumSha256 = checksum;

    const cloudProject = await json<{ id: string }>(
      await this.account.authenticatedFetch("/api/v1/cloud/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(project.cloudProjectId ? { cloudProjectId: project.cloudProjectId } : {}),
          clientProjectId: project.id,
          name: project.name,
        }),
      }),
    );
    if (!project.cloudProjectId) {
      await this.projects.execute({
        type: "project.attachCloud",
        cloudProjectId: cloudProject.id as CloudProjectId,
      });
      this.#emitProject();
    }

    const upload = uploadSchema.parse(
      await json<unknown>(
        record.uploadId
          ? await this.account.authenticatedFetch(
              `/api/v1/cloud/uploads/${encodeURIComponent(record.uploadId)}`,
            )
          : await this.account.authenticatedFetch("/api/v1/cloud/uploads", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                cloudProjectId: cloudProject.id,
                clientAssetId: asset.id,
                name: asset.name,
                kind: asset.kind,
                contentType: contentType(record.sourcePath),
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
        const signed = await json<{ parts: { partNumber: number; url: string }[] }>(
          await this.account.authenticatedFetch(
            `/api/v1/cloud/uploads/${encodeURIComponent(upload.id)}/parts/sign`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ partNumbers }),
              signal,
            },
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
    record.state = "complete";
    await this.#persistAndEmit();
    await shell
      .trashItem(record.sourcePath)
      .catch((error: unknown) =>
        log.warn(
          { err: error, operation: "trash-local-original", assetId },
          "Cloud original is ready, but the local source could not be moved to Trash",
        ),
      );
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
    for (const target of BrowserWindow.getAllWindows())
      target.webContents.send("cloud:transfers-changed", snapshot);
  }

  #emitProject(): void {
    const session = this.projects.session();
    for (const target of BrowserWindow.getAllWindows())
      target.webContents.send("project:changed", session);
  }
}

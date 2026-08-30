import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Project } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import type { TransferRecord } from "./transfer-repository";

const log = createCinesimLogger({ service: "cloud-original-cache" });

interface CloudProjectSource {
  readonly directory: string | null;
  readonly project: Project | null;
}

interface SignedDownload {
  url: string;
  bytes: number;
  expiresAt: number;
}

export class CloudOriginalCache {
  readonly #downloadOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly projects: CloudProjectSource,
    private readonly signedDownload: (cloudAssetId: string) => Promise<SignedDownload>,
  ) {}

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
    const directory = await this.#existingOriginalsDirectory(this.projects.directory);
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

    const originalsDirectory = await this.#ensureOriginalsDirectory(projectDirectory);
    const destination = join(originalsDirectory, asset.id);
    await this.#ensureDownloaded(asset.source.cloudAssetId, destination);
    return this.downloadedOriginals();
  }

  async removeDownload(assetId: string): Promise<string[]> {
    const projectDirectory = this.projects.directory;
    const asset = this.projects.project?.assets.find((candidate) => candidate.id === assetId);
    if (!projectDirectory || !asset || asset.source.kind !== "cloud")
      throw new Error("Only cloud-backed originals can remove a local download");
    const originalsDirectory = await this.#existingOriginalsDirectory(projectDirectory);
    if (originalsDirectory) {
      const destination = join(originalsDirectory, asset.id);
      await this.#downloadOperations.get(destination);
      await rm(destination, { force: true });
    }
    return this.downloadedOriginals();
  }

  async removeManagedSource(record: TransferRecord): Promise<void> {
    try {
      const originalsDirectory = await this.#existingOriginalsDirectory(record.projectDirectory);
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

  async #downloadOriginal(cloudAssetId: string, destination: string): Promise<void> {
    const signed = await this.signedDownload(cloudAssetId);
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

  async #ensureDownloaded(cloudAssetId: string, destination: string): Promise<void> {
    const existing = this.#downloadOperations.get(destination);
    if (existing) {
      await existing;
      return;
    }

    const operation = this.#downloadOriginal(cloudAssetId, destination);
    this.#downloadOperations.set(destination, operation);
    try {
      await operation;
    } finally {
      if (this.#downloadOperations.get(destination) === operation) {
        this.#downloadOperations.delete(destination);
      }
    }
  }

  #existingOriginalsDirectory(projectDirectory: string): Promise<string | null> {
    return this.#originalsDirectory(projectDirectory, false);
  }

  async #ensureOriginalsDirectory(projectDirectory: string): Promise<string> {
    const directory = await this.#originalsDirectory(projectDirectory, true);
    if (!directory) throw new Error("The downloaded originals directory is unavailable");
    return directory;
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
}

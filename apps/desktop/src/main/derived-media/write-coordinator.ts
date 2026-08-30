import { readFile, rename } from "node:fs/promises";
import { relative } from "node:path";
import type { Asset, Project, ProjectSettings } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import type { ProjectPaths } from "@cinesim/project-io";
import type {
  BeginDerivedWrite,
  DerivedMediaEvent,
  DerivedProjectScope,
  FinalizeDerivedWrite,
} from "../../shared/contracts";
import { decodeWaveformEnvelope } from "../../shared/waveform-format";
import { validateFinalize } from "./artifact-validation";
import type { DerivedArtifactRepository } from "./artifact-repository";
import type { PersistedAsset, PersistedIndex } from "./model";
import { DerivedWriterRegistry } from "./writer-registry";

const log = createCinesimLogger({ service: "derived-media" });

interface DerivedWriteHost {
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  assertScope(scope: DerivedProjectScope): void;
  directory(): string;
  paths(): ProjectPaths;
  project(): Project;
  settings(): ProjectSettings;
  index(): PersistedIndex;
  asset(assetId: string): Asset;
  ensureAsset(asset: Asset): Promise<PersistedAsset>;
  queueProxy(asset: Asset): Promise<void>;
  updateRuntimeProgress(assetId: string, progress: number): void;
  persist(): Promise<void>;
  emit(): void;
  log(event: Omit<DerivedMediaEvent, "at">): void;
}

export class DerivedWriteCoordinator {
  readonly #writers = new DerivedWriterRegistry();

  constructor(
    private readonly host: DerivedWriteHost,
    private readonly artifacts: DerivedArtifactRepository,
  ) {}

  async begin(scope: DerivedProjectScope, input: BeginDerivedWrite): Promise<{ writerId: string }> {
    return this.host.serialize(async () => {
      this.host.assertScope(scope);
      if (input.kind === "proxy" && !this.artifacts.diskHeadroomAvailable)
        throw new Error("Insufficient disk headroom for a proxy");
      const directory = this.host.directory();
      const asset = this.host.asset(input.assetId);
      const record = await this.host.ensureAsset(asset);
      const writer = await this.#writers.begin(directory, this.host.paths(), asset, input);
      const artifact = record[input.kind];
      artifact.state = "running";
      artifact.progress = 0;
      delete artifact.failureCode;
      artifact.updatedAt = new Date().toISOString();
      await this.host.persist();
      this.host.emit();
      log.info(
        { operation: "write-begin", assetId: input.assetId, artifactKind: input.kind },
        "derived artifact write started",
      );
      return { writerId: writer.id };
    });
  }

  async writeChunk(writerId: string, offset: number, data: Uint8Array): Promise<void> {
    await this.host.serialize(async () => {
      const writer = await this.#writers.writeChunk(
        writerId,
        this.host.directory(),
        this.host.index(),
        offset,
        data,
      );
      if (writer) this.host.emit();
    });
  }

  async finalize(writerId: string, result: FinalizeDerivedWrite): Promise<void> {
    await this.host.serialize(async () => {
      const directory = this.host.directory();
      const writer = this.#writers.get(writerId, directory);
      if (!writer) return;
      if (
        !Number.isSafeInteger(result.bytes) ||
        result.bytes <= 0 ||
        result.bytes !== writer.maxEnd
      )
        throw new Error("Derived artifact size does not match written data");
      if (writer.expectedBytes && result.bytes !== writer.expectedBytes)
        throw new Error("Derived artifact does not match expected size");
      validateFinalize(writer.kind, result, this.host.asset(writer.assetId));
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
      const index = this.host.index();
      const record = index.assets[writer.assetId]!;
      const artifact = record[writer.kind];
      artifact.state = "ready";
      artifact.relativePath = relative(directory, writer.finalPath);
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
      this.host.log({
        assetId: writer.assetId,
        kind: `${writer.kind}-ready`,
        detail: `${writer.kind} generated (${result.bytes} bytes)`,
      });
      await this.artifacts.refreshStorage(directory, index);
      if (writer.kind === "proxy" && this.host.settings().proxyGeneration === "automatic")
        await this.host.queueProxy(this.host.asset(writer.assetId));
      await this.artifacts.evict(
        this.host.paths(),
        directory,
        index,
        this.host.project(),
        (event) => this.host.log(event),
      );
      await this.host.persist();
      this.host.emit();
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
    await this.host.serialize(async () => {
      if (!Number.isFinite(progress) || progress < 0 || progress > 1)
        throw new Error("Invalid derived progress");
      const writer = this.#writers.get(writerId, this.host.directory());
      if (!writer) return;
      this.host.index().assets[writer.assetId]![writer.kind].progress = progress;
      this.host.updateRuntimeProgress(writer.assetId, progress);
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
      this.host.emit();
    });
  }

  async cancel(writerId: string, failureCode?: string, detail?: string): Promise<void> {
    await this.host.serialize(async () => {
      const writer = this.#writers.get(writerId, this.host.directory());
      if (!writer) return;
      await this.#writers.cancel(writer);
      const artifact = this.host.index().assets[writer.assetId]![writer.kind];
      artifact.state = failureCode ? "failed" : "queued";
      artifact.progress = 0;
      if (failureCode) artifact.failureCode = failureCode;
      else delete artifact.failureCode;
      artifact.updatedAt = new Date().toISOString();
      await this.host.persist();
      this.host.emit();
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

  async closeAll(): Promise<void> {
    await this.#writers.closeAll();
  }

  async removeAssets(assetIds: ReadonlySet<string>): Promise<void> {
    await this.#writers.removeAssets(assetIds);
  }
}

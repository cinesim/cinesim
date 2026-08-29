import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Asset } from "@cinesim/core";
import type { ProjectPaths } from "@cinesim/project-io";
import type { BeginDerivedWrite } from "../../shared/api";
import { waveformByteLength, waveformPeakCount } from "../../shared/waveform-format";
import { validateWriteInput } from "./artifact-validation";
import {
  artifactPath,
  MAX_ARTIFACT_BYTES,
  MAX_CHUNK_BYTES,
  MAX_RETIRED_WRITERS,
  MAX_WRITERS,
} from "./model";
import type { PersistedIndex, WriterSession } from "./model";

export class DerivedWriterRegistry {
  readonly #writers = new Map<string, WriterSession>();
  readonly #retired = new Set<string>();
  readonly #progressBuckets = new Map<string, number>();

  async begin(
    directory: string,
    paths: ProjectPaths,
    asset: Asset,
    input: BeginDerivedWrite,
  ): Promise<WriterSession> {
    validateWriteInput(input);
    if (this.#writers.size >= MAX_WRITERS) throw new Error("Too many derived writers");
    if (
      input.kind === "waveform" &&
      input.expectedBytes !== waveformByteLength(waveformPeakCount(asset.durationUs))
    )
      throw new Error("Waveform writer requires the exact bounded artifact size");
    const id = randomUUID();
    const finalPath = paths.derived(artifactPath(input.kind, input.assetId, input.profileId));
    const tempPath = `${finalPath}.${id}.tmp`;
    await mkdir(dirname(finalPath), { recursive: true });
    const handle = await open(tempPath, "wx+");
    const writer: WriterSession = {
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
    };
    this.#writers.set(id, writer);
    return writer;
  }

  async writeChunk(
    id: string,
    directory: string,
    index: PersistedIndex,
    offset: number,
    data: Uint8Array,
  ): Promise<WriterSession | null> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > MAX_CHUNK_BYTES)
      throw new Error("Invalid derived chunk");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid derived offset");
    const writer = this.get(id, directory);
    if (!writer) return null;
    const end = offset + data.byteLength;
    if (end > MAX_ARTIFACT_BYTES || (writer.expectedBytes && end > writer.expectedBytes))
      throw new Error("Derived artifact exceeds its bound");
    await writer.handle.write(data, 0, data.byteLength, offset);
    writer.maxEnd = Math.max(writer.maxEnd, end);
    if (writer.expectedBytes)
      index.assets[writer.assetId]![writer.kind].progress = Math.min(
        0.99,
        writer.maxEnd / writer.expectedBytes,
      );
    return writer;
  }

  get(id: string, directory: string): WriterSession | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid derived writer ID");
    const writer = this.#writers.get(id);
    if (!writer) {
      if (this.#retired.has(id)) return null;
      throw new Error("Unknown derived writer");
    }
    if (writer.projectDirectory !== directory) throw new Error("Unknown derived writer");
    return writer;
  }

  complete(id: string): void {
    this.#writers.delete(id);
    this.#progressBuckets.delete(id);
  }

  progressBucket(id: string, progress: number): boolean {
    const bucket = Math.min(4, Math.floor(progress * 4));
    if (this.#progressBuckets.get(id) === bucket) return false;
    this.#progressBuckets.set(id, bucket);
    return true;
  }

  async cancel(writer: WriterSession): Promise<void> {
    await writer.handle.close().catch(() => undefined);
    await rm(writer.tempPath, { force: true });
    this.complete(writer.id);
  }

  async removeAssets(assetIds: ReadonlySet<string>): Promise<void> {
    for (const writer of this.#writers.values()) {
      if (!assetIds.has(writer.assetId)) continue;
      this.#retire(writer.id);
      await writer.handle.close().catch(() => undefined);
      await rm(writer.tempPath, { force: true }).catch(() => undefined);
      this.complete(writer.id);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#writers.values()].map(async (writer) => {
        this.#retire(writer.id);
        await writer.handle.close().catch(() => undefined);
        await rm(writer.tempPath, { force: true });
      }),
    );
    this.#writers.clear();
    this.#progressBuckets.clear();
  }

  #retire(id: string): void {
    this.#retired.add(id);
    if (this.#retired.size > MAX_RETIRED_WRITERS)
      this.#retired.delete(this.#retired.values().next().value!);
  }
}

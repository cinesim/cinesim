import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { stableJson } from "@cinesim/core";

const MAX_TRANSFER_JOURNAL_BYTES = 8 * 1024 * 1024;

export const transferRecordSchema = z
  .object({
    userId: z.string().min(1).max(256),
    cloudProjectId: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u),
    assetId: z.string().regex(/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u),
    cloudAssetId: z
      .string()
      .regex(/^cloud_asset_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u)
      .nullable(),
    uploadId: z
      .string()
      .regex(/^cloud_upload_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u)
      .nullable(),
    projectDirectory: z.string().min(1).max(32_768),
    sourcePath: z.string().min(1).max(32_768),
    managedSource: z.boolean().default(false),
    name: z.string().min(1).max(1_024),
    bytes: z.number().int().positive().safe(),
    uploadedBytes: z.number().int().nonnegative().safe(),
    state: z.enum([
      "waiting-for-cloud",
      "preparing",
      "uploading",
      "waiting-for-proxy",
      "paused",
      "failed",
      "complete",
    ]),
    error: z.string().max(2_000).nullable(),
    checksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    sourceFingerprint: z
      .object({
        size: z.number().int().nonnegative().safe(),
        mtimeMs: z.number().nonnegative().finite(),
        edgeHash: z.string().min(1).max(256),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((record) => record.uploadedBytes <= record.bytes, "Uploaded bytes exceed source size");

export type TransferRecord = z.infer<typeof transferRecordSchema>;

export class CloudTransferRepository {
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<TransferRecord[]> {
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_TRANSFER_JOURNAL_BYTES)
        throw new Error("Cloud transfer journal is outside its size bound");
      return z
        .array(transferRecordSchema)
        .max(20_000)
        .parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(records: readonly TransferRecord[]): Promise<void> {
    const contents = stableJson(z.array(transferRecordSchema).max(20_000).parse(records));
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const operation = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, contents, "utf8");
        await rename(temporary, this.path);
      });
    this.#writeQueue = operation;
    await operation;
  }
}

import { join } from "node:path";
import { z } from "zod";
import { stableJson } from "@cinesim/core";
import type { SourceFingerprint } from "../../shared/contracts";
import { TRANSCRIPT_GENERATOR_VERSION } from "../../shared/transcript";
import { AtomicFileRepository } from "../app/atomic-file-repository";

const INDEX_PATH = join(".video", "transcripts", "index.json");
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const fingerprintSchema = z
  .object({
    size: z.number().int().nonnegative().safe(),
    mtimeMs: z.number().nonnegative().finite(),
    edgeHash: z.string().min(1).max(256),
  })
  .strict();
const recordSchema = z
  .object({
    state: z.enum(["missing", "queued", "ready", "failed"]),
    sourceFingerprint: fingerprintSchema.optional(),
    failureCode: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
      .optional(),
  })
  .strict();
const indexSchema = z
  .object({
    version: z.literal(1),
    generatorVersion: z.literal(TRANSCRIPT_GENERATOR_VERSION),
    assets: z.record(z.string().regex(/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u), recordSchema),
  })
  .strict();

export interface PersistedTranscriptRecord {
  state: "missing" | "queued" | "ready" | "failed";
  sourceFingerprint?: SourceFingerprint;
  failureCode?: string;
}

export interface PersistedTranscriptIndex {
  version: 1;
  generatorVersion: typeof TRANSCRIPT_GENERATOR_VERSION;
  assets: Record<string, PersistedTranscriptRecord>;
}

export function emptyTranscriptIndex(): PersistedTranscriptIndex {
  return { version: 1, generatorVersion: TRANSCRIPT_GENERATOR_VERSION, assets: {} };
}

export class TranscriptIndexRepository {
  readonly #files = new AtomicFileRepository();

  async read(directory: string): Promise<PersistedTranscriptIndex> {
    const path = join(directory, INDEX_PATH);
    try {
      return indexSchema.parse(
        JSON.parse(await this.#files.readText(path, MAX_INDEX_BYTES)),
      ) as PersistedTranscriptIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyTranscriptIndex();
      await this.#files.quarantine(path).catch(() => undefined);
      return emptyTranscriptIndex();
    }
  }

  async write(directory: string, index: PersistedTranscriptIndex): Promise<void> {
    const contents = stableJson(indexSchema.parse(index));
    const path = join(directory, INDEX_PATH);
    await this.#files.writeText(path, contents, { maxBytes: MAX_INDEX_BYTES });
  }
}

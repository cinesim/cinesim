import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "@cinesim/core";
import type { StoredGatewayTranscript } from "./gateway";
import { gatewayTranscriptSchema, MAX_GATEWAY_RESPONSE_BYTES } from "./gateway";

const JOBS_DIRECTORY = join(".video", "transcripts", ".jobs");

function jobDirectory(directory: string, jobId: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(jobId)) throw new Error("Invalid transcript job ID");
  return join(directory, JOBS_DIRECTORY, jobId);
}

function chunkPath(directory: string, jobId: string, chunkIndex: number): string {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0)
    throw new Error("Invalid transcript chunk index");
  return join(jobDirectory(directory, jobId), `${chunkIndex}.json`);
}

export class TranscriptChunkRepository {
  async write(
    directory: string,
    jobId: string,
    chunkIndex: number,
    transcript: StoredGatewayTranscript,
  ): Promise<void> {
    const path = chunkPath(directory, jobId, chunkIndex);
    await mkdir(jobDirectory(directory, jobId), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, stableJson(transcript), "utf8");
    await rename(temporaryPath, path);
  }

  async read(
    directory: string,
    jobId: string,
    chunkIndex: number,
  ): Promise<StoredGatewayTranscript> {
    const path = chunkPath(directory, jobId, chunkIndex);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_GATEWAY_RESPONSE_BYTES)
      throw new Error("Persisted transcript chunk is outside its size bound");
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return gatewayTranscriptSchema
      .omit({ text: true, model: true })
      .parse(value) as StoredGatewayTranscript;
  }

  async removeJob(directory: string, jobId: string): Promise<void> {
    await rm(jobDirectory(directory, jobId), { recursive: true, force: true });
  }
}

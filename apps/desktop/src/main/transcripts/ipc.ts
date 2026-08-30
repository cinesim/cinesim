import { z } from "zod";
import { assetIdSchema, timeUsSchema } from "@cinesim/protocol";
import type { TranscriptAudioChunkInput } from "../../shared/transcript";
import { parseDerivedProjectScope } from "../derived-media/ipc-validation";
import type { TranscriptStore } from "./service";
import { registerIpcHandler } from "../app/secure-ipc";

const assetIdsSchema = z.array(assetIdSchema).max(500);
const transcriptAudioChunkSchema = z
  .object({
    jobId: z.string().uuid(),
    chunkIndex: z.number().int().nonnegative().safe(),
    sourceStartUs: timeUsSchema,
    sourceEndUs: timeUsSchema,
    data: z.instanceof(Uint8Array),
  })
  .transform((value): TranscriptAudioChunkInput => value);

const parseAssetIds = (value: unknown) => assetIdsSchema.parse(value);

export function registerTranscriptIpc(store: TranscriptStore): void {
  registerIpcHandler("transcripts:get", (scope: unknown, assetIds: unknown = []) =>
    store.snapshot(parseDerivedProjectScope(scope), parseAssetIds(assetIds)),
  );
  registerIpcHandler("transcripts:request", (scope: unknown, assetIds: unknown) =>
    store.requestJobs(parseDerivedProjectScope(scope), parseAssetIds(assetIds)),
  );
  registerIpcHandler("transcripts:cancel", (scope: unknown, assetIds: unknown) =>
    store.cancelJobs(parseDerivedProjectScope(scope), parseAssetIds(assetIds)),
  );
  registerIpcHandler("transcripts:begin", (scope: unknown, assetId: unknown) => {
    return store.beginJob(parseDerivedProjectScope(scope), assetIdSchema.parse(assetId));
  });
  registerIpcHandler("transcripts:chunk", (scope: unknown, input: unknown) =>
    store.transcribeChunk(parseDerivedProjectScope(scope), transcriptAudioChunkSchema.parse(input)),
  );
  registerIpcHandler("transcripts:finalize", (scope: unknown, jobId: unknown) => {
    if (typeof jobId !== "string") throw new Error("Invalid transcript job ID");
    return store.finalizeJob(parseDerivedProjectScope(scope), jobId);
  });
  registerIpcHandler(
    "transcripts:fail",
    (scope: unknown, jobId: unknown, failureCode: unknown, detail: unknown) => {
      if (
        typeof jobId !== "string" ||
        typeof failureCode !== "string" ||
        (detail !== undefined && typeof detail !== "string")
      ) {
        throw new Error("Invalid transcript job failure");
      }
      return store.failJob(parseDerivedProjectScope(scope), jobId, failureCode, detail);
    },
  );
}

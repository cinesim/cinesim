import { z } from "zod";
import type { AssetId, TimeUs } from "@cinesim/core";
import { assetIdSchema, timeUsSchema } from "@cinesim/protocol";
import type { DerivedProjectScope } from "../../shared/contracts";
import type { TranscriptAudioChunkInput, TranscriptSnapshot } from "../../shared/transcript";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { boundedIdSchema, MAX_REQUEST_IDS } from "../app/ipc-schemas";
import { derivedProjectScopeSchema } from "../derived-media/ipc-validation";

const MAX_AUDIO_CHUNK_BYTES = 24 * 1024 * 1024;
const assetIdsSchema = z.array(assetIdSchema).max(MAX_REQUEST_IDS);
const transcriptAudioChunkSchema = z
  .object({
    jobId: z.string().uuid(),
    chunkIndex: z.number().int().nonnegative().safe(),
    sourceStartUs: timeUsSchema,
    sourceEndUs: timeUsSchema,
    data: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength > 0 && value.byteLength <= MAX_AUDIO_CHUNK_BYTES),
  })
  .strict()
  .transform((value): TranscriptAudioChunkInput => value);
const snapshotContract = <TArguments extends unknown[]>(
  channel: string,
  request: z.ZodType<TArguments>,
) =>
  defineInvokeContract<TArguments, TranscriptSnapshot>({
    channel,
    request,
    privilege: "reversible-mutation",
  });

export const transcriptContracts = {
  get: snapshotContract(
    invokeChannels.transcripts.get,
    z.tuple([
      z
        .object({
          scope: derivedProjectScopeSchema,
          assetIds: assetIdsSchema.optional().default([]),
        })
        .strict(),
    ]),
  ),
  request: snapshotContract(
    invokeChannels.transcripts.request,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema }).strict()]),
  ),
  regenerate: snapshotContract(
    invokeChannels.transcripts.regenerate,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema }).strict()]),
  ),
  cancel: snapshotContract(
    invokeChannels.transcripts.cancel,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema }).strict()]),
  ),
  begin: defineInvokeContract<
    [{ scope: DerivedProjectScope; assetId: AssetId }],
    { jobId: string }
  >({
    channel: invokeChannels.transcripts.begin,
    request: z.tuple([
      z.object({ scope: derivedProjectScopeSchema, assetId: assetIdSchema }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  chunk: defineInvokeContract<
    [{ scope: DerivedProjectScope; input: TranscriptAudioChunkInput }],
    void
  >({
    channel: invokeChannels.transcripts.chunk,
    request: z.tuple([
      z.object({ scope: derivedProjectScopeSchema, input: transcriptAudioChunkSchema }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  finalize: snapshotContract(
    invokeChannels.transcripts.finalize,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, jobId: boundedIdSchema }).strict()]),
  ),
  fail: snapshotContract(
    invokeChannels.transcripts.fail,
    z.tuple([
      z
        .object({
          scope: derivedProjectScopeSchema,
          jobId: boundedIdSchema,
          failureCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
          detail: z.string().max(2_000).optional(),
        })
        .strict(),
    ]),
  ),
} as const;

export type TranscriptChunkRange = { sourceStartUs: TimeUs; sourceEndUs: TimeUs };

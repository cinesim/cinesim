import { timeUs } from "@cinesim/core";
import type {
  ExportCapabilitySnapshot,
  ExportJobSnapshot,
  ExportRenderCompletion,
  ExportRenderFailure,
  ExportStartRequest,
} from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { z } from "zod";
import { defineInvokeContract } from "../app/ipc-contract";
import { boundedIdSchema } from "../app/ipc-schemas";
import { MAX_EXPORT_CHUNK_BYTES } from "./service";

const presetSchema = z.enum(["h264-aac-sdr-1080p", "h264-aac-sdr-source"]);
const optionalTimeSchema = z.number().int().nonnegative().safe().transform(timeUs).optional();
const startSchema = z
  .object({
    sequenceId: z.string().min(1).max(200).optional(),
    presetId: presetSchema,
    startUs: optionalTimeSchema,
    endUs: optionalTimeSchema,
    fileName: z.string().min(5).max(124).optional(),
  })
  .strict()
  .transform((value): ExportStartRequest => value as ExportStartRequest);
const statusSchema = z
  .object({ jobId: boundedIdSchema.optional() })
  .strict()
  .transform((value): { jobId?: string } => value as { jobId?: string });
const completionSchema = z
  .object({
    jobId: boundedIdSchema,
    bytes: z.number().int().positive().safe(),
    videoFrames: z.number().int().nonnegative().safe(),
    audioFrames: z.number().int().nonnegative().safe(),
  })
  .strict();
const failureSchema = z
  .object({
    jobId: boundedIdSchema,
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    detail: z.string().min(1).max(2_000),
  })
  .strict();

export const exportContracts = {
  capabilities: defineInvokeContract<[], ExportCapabilitySnapshot>({
    channel: invokeChannels.exports.capabilities,
    request: z.tuple([]),
    privilege: "read",
  }),
  status: defineInvokeContract<[{ jobId?: string }], ExportJobSnapshot[]>({
    channel: invokeChannels.exports.status,
    request: z.tuple([statusSchema]),
    privilege: "read",
  }),
  start: defineInvokeContract<[ExportStartRequest], ExportJobSnapshot>({
    channel: invokeChannels.exports.start,
    request: z.tuple([startSchema]),
    privilege: "reversible-mutation",
  }),
  cancel: defineInvokeContract<[{ jobId: string }], ExportJobSnapshot>({
    channel: invokeChannels.exports.cancel,
    request: z.tuple([z.object({ jobId: boundedIdSchema }).strict()]),
    privilege: "reversible-mutation",
  }),
  writeChunk: defineInvokeContract<[{ jobId: string; offset: number; data: Uint8Array }], void>({
    channel: invokeChannels.exports.writeChunk,
    request: z.tuple([
      z
        .object({
          jobId: boundedIdSchema,
          offset: z.number().int().nonnegative().safe(),
          data: z
            .instanceof(Uint8Array)
            .refine((value) => value.byteLength > 0 && value.byteLength <= MAX_EXPORT_CHUNK_BYTES),
        })
        .strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  progress: defineInvokeContract<[{ jobId: string; progress: number }], void>({
    channel: invokeChannels.exports.progress,
    request: z.tuple([
      z.object({ jobId: boundedIdSchema, progress: z.number().min(0).max(1) }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  complete: defineInvokeContract<[ExportRenderCompletion], ExportJobSnapshot>({
    channel: invokeChannels.exports.complete,
    request: z.tuple([completionSchema]),
    privilege: "reversible-mutation",
  }),
  fail: defineInvokeContract<[ExportRenderFailure], void>({
    channel: invokeChannels.exports.fail,
    request: z.tuple([failureSchema]),
    privilege: "reversible-mutation",
  }),
} as const;

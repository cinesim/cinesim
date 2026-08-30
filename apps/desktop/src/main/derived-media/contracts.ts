import { z } from "zod";
import type {
  BeginDerivedWrite,
  DerivedMediaSnapshot,
  DerivedPerformanceObservation,
  DerivedProjectScope,
  DerivedWorkerActivity,
  FinalizeDerivedWrite,
} from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { boundedIdSchema } from "../app/ipc-schemas";
import {
  beginDerivedWriteSchema,
  derivedPerformanceObservationSchema,
  derivedProjectScopeSchema,
  derivedWorkerActivitySchema,
  finalizeDerivedWriteSchema,
} from "./ipc-validation";
import { MAX_CHUNK_BYTES } from "./model";

const assetIdsSchema = z.array(z.string().min(1).max(200)).max(500);
const snapshotContract = <TArguments extends unknown[]>(
  channel: string,
  request: z.ZodType<TArguments>,
) =>
  defineInvokeContract<TArguments, DerivedMediaSnapshot>({
    channel,
    request,
    privilege: "reversible-mutation",
  });

export const derivedContracts = {
  get: snapshotContract(
    invokeChannels.derived.get,
    z.tuple([z.object({ scope: derivedProjectScopeSchema }).strict()]),
  ),
  requestJobs: snapshotContract(
    invokeChannels.derived.requestJobs,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema }).strict()]),
  ),
  requestProxies: snapshotContract(
    invokeChannels.derived.requestProxies,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema }).strict()]),
  ),
  writeBegin: defineInvokeContract<
    [{ scope: DerivedProjectScope; input: BeginDerivedWrite }],
    { writerId: string }
  >({
    channel: invokeChannels.derived.writeBegin,
    request: z.tuple([
      z.object({ scope: derivedProjectScopeSchema, input: beginDerivedWriteSchema }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  writeChunk: defineInvokeContract<[{ writerId: string; offset: number; data: Uint8Array }], void>({
    channel: invokeChannels.derived.writeChunk,
    request: z.tuple([
      z
        .object({
          writerId: boundedIdSchema,
          offset: z.number().int().nonnegative().safe(),
          data: z
            .instanceof(Uint8Array)
            .refine((value) => value.byteLength > 0 && value.byteLength <= MAX_CHUNK_BYTES),
        })
        .strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  writeFinalize: defineInvokeContract<[{ writerId: string; result: FinalizeDerivedWrite }], void>({
    channel: invokeChannels.derived.writeFinalize,
    request: z.tuple([
      z.object({ writerId: boundedIdSchema, result: finalizeDerivedWriteSchema }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  writeCancel: defineInvokeContract<
    [{ writerId: string; failureCode?: string | undefined; detail?: string | undefined }],
    void
  >({
    channel: invokeChannels.derived.writeCancel,
    request: z.tuple([
      z
        .object({
          writerId: boundedIdSchema,
          failureCode: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
            .optional(),
          detail: z.string().max(2_000).optional(),
        })
        .strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  writeProgress: defineInvokeContract<[{ writerId: string; progress: number }], void>({
    channel: invokeChannels.derived.writeProgress,
    request: z.tuple([
      z.object({ writerId: boundedIdSchema, progress: z.number().min(0).max(1).finite() }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  activity: defineInvokeContract<
    [{ scope: DerivedProjectScope; activity: DerivedWorkerActivity }],
    void
  >({
    channel: invokeChannels.derived.activity,
    request: z.tuple([
      z
        .object({ scope: derivedProjectScopeSchema, activity: derivedWorkerActivitySchema })
        .strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  performance: defineInvokeContract<
    [{ scope: DerivedProjectScope; observation: DerivedPerformanceObservation }],
    void
  >({
    channel: invokeChannels.derived.performance,
    request: z.tuple([
      z
        .object({
          scope: derivedProjectScopeSchema,
          observation: derivedPerformanceObservationSchema,
        })
        .strict(),
    ]),
    privilege: "reversible-mutation",
  }),
} as const;

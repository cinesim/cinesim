import { z } from "zod";
import type { VisualIndexAssetStatus, VisualIndexObservation } from "@cinesim/project-io";
import { assetIdSchema } from "@cinesim/protocol";
import type { DerivedProjectScope } from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { MAX_REQUEST_IDS } from "../app/ipc-schemas";
import { derivedProjectScopeSchema } from "../derived-media/ipc-validation";

export const visualIndexSafeTimeSchema = z.number().int().nonnegative().safe();
const assetIdsSchema = z.array(assetIdSchema).min(1).max(MAX_REQUEST_IDS);
const rangeSchema = z
  .object({
    fromUs: visualIndexSafeTimeSchema.optional(),
    toUs: visualIndexSafeTimeSchema.optional(),
    limit: z.number().int().min(1).max(2_000).optional(),
  })
  .strict()
  .optional();
export const visualIndexObservationSchema = z
  .object({
    id: z
      .string()
      .regex(/^observation_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
      .max(128),
    sourceInUs: visualIndexSafeTimeSchema,
    sourceOutUs: visualIndexSafeTimeSchema,
    description: z.string().trim().min(1).max(2_000),
    people: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    setting: z.string().trim().min(1).max(500).optional(),
    shotType: z.string().trim().min(1).max(100).optional(),
    tags: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    continuity: z.string().trim().min(1).max(1_000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    provenance: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.sourceOutUs > value.sourceInUs, "Observation range must be positive");
const selectorSchema = z
  .object({
    observationIds: z.array(z.string().max(128)).max(500).optional(),
    fromUs: visualIndexSafeTimeSchema.optional(),
    toUs: visualIndexSafeTimeSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.observationIds?.length ?? 0) > 0 ||
      value.fromUs !== undefined ||
      value.toUs !== undefined,
    "A visual-index delete selector is required",
  );

const statusResult = <TArguments extends unknown[]>(
  channel: string,
  request: z.ZodType<TArguments>,
  privilege: "read" | "reversible-mutation",
) => defineInvokeContract<TArguments, VisualIndexAssetStatus[]>({ channel, request, privilege });

export const visualIndexContracts = {
  status: statusResult(
    invokeChannels.visualIndex.status,
    z.tuple([
      z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema.optional() }).strict(),
    ]),
    "read",
  ),
  get: defineInvokeContract<
    [{ scope: DerivedProjectScope; assetId: string; range?: z.infer<typeof rangeSchema> }],
    {
      status: VisualIndexAssetStatus;
      observations: VisualIndexObservation[];
      truncated: boolean;
    }
  >({
    channel: invokeChannels.visualIndex.get,
    request: z.tuple([
      z
        .object({ scope: derivedProjectScopeSchema, assetId: assetIdSchema, range: rangeSchema })
        .strict(),
    ]),
    privilege: "read",
  }),
  generate: statusResult(
    invokeChannels.visualIndex.generate,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema }).strict()]),
    "reversible-mutation",
  ),
  regenerate: statusResult(
    invokeChannels.visualIndex.regenerate,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema }).strict()]),
    "reversible-mutation",
  ),
  upsert: defineInvokeContract<
    [
      {
        scope: DerivedProjectScope;
        assetId: string;
        observations: Array<z.output<typeof visualIndexObservationSchema>>;
      },
    ],
    VisualIndexAssetStatus
  >({
    channel: invokeChannels.visualIndex.upsert,
    request: z.tuple([
      z
        .object({
          scope: derivedProjectScopeSchema,
          assetId: assetIdSchema,
          observations: z.array(visualIndexObservationSchema).min(1).max(500),
        })
        .strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  delete: defineInvokeContract<
    [
      {
        scope: DerivedProjectScope;
        assetId: string;
        selector: z.infer<typeof selectorSchema>;
      },
    ],
    VisualIndexAssetStatus
  >({
    channel: invokeChannels.visualIndex.delete,
    request: z.tuple([
      z
        .object({
          scope: derivedProjectScopeSchema,
          assetId: assetIdSchema,
          selector: selectorSchema,
        })
        .strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  clear: statusResult(
    invokeChannels.visualIndex.clear,
    z.tuple([z.object({ scope: derivedProjectScopeSchema, assetIds: assetIdsSchema }).strict()]),
    "reversible-mutation",
  ),
} as const;

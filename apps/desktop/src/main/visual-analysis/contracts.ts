import { z } from "zod";
import type {
  DerivedProjectScope,
  VisualAnalysisCompletion,
  VisualAnalysisFailure,
} from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { boundedIdSchema } from "../app/ipc-schemas";
import { derivedProjectScopeSchema } from "../derived-media/ipc-validation";
import { visualIndexObservationSchema, visualIndexSafeTimeSchema } from "../visual-index/contracts";

const optionValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().max(200),
  z.null(),
]);
const optionsSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u), optionValueSchema)
  .refine((value) => Object.keys(value).length <= 50);
const rangeSchema = z
  .object({ sourceInUs: visualIndexSafeTimeSchema, sourceOutUs: visualIndexSafeTimeSchema })
  .strict()
  .refine((value) => value.sourceOutUs > value.sourceInUs);

const completionSchema = z
  .object({
    requestId: boundedIdSchema,
    options: optionsSchema,
    coverage: z.array(rangeSchema).max(180),
    observations: z.array(visualIndexObservationSchema).max(180),
  })
  .strict()
  // Zod models absent optional observation fields as `T | undefined`; parsing a strict object
  // cannot introduce those undefined properties, so expose the narrower bridge contract.
  .transform((value): VisualAnalysisCompletion => value as VisualAnalysisCompletion);
const failureSchema = z
  .object({
    requestId: boundedIdSchema,
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    detail: z.string().min(1).max(2_000),
  })
  .strict();

export const visualAnalysisContracts = {
  complete: defineInvokeContract<
    [{ scope: DerivedProjectScope; completion: VisualAnalysisCompletion }],
    void
  >({
    channel: invokeChannels.visualAnalysis.complete,
    request: z.tuple([
      z.object({ scope: derivedProjectScopeSchema, completion: completionSchema }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  fail: defineInvokeContract<
    [{ scope: DerivedProjectScope; failure: VisualAnalysisFailure }],
    void
  >({
    channel: invokeChannels.visualAnalysis.fail,
    request: z.tuple([
      z.object({ scope: derivedProjectScopeSchema, failure: failureSchema }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
} as const;

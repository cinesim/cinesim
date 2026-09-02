import { z } from "zod";
import { timeUs } from "@cinesim/core";
import type {
  DerivedProjectScope,
  FrameRenderCompletion,
  FrameRenderFailure,
} from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { boundedIdSchema } from "../app/ipc-schemas";
import { derivedProjectScopeSchema } from "../derived-media/ipc-validation";
import { MAX_FRAME_BYTES } from "./service";

const completionSchema = z
  .object({
    requestId: boundedIdSchema,
    renderedTimeUs: z.number().int().nonnegative().safe().transform(timeUs),
    width: z.number().int().positive().max(1920),
    height: z.number().int().positive().max(1920),
    png: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength > 0 && value.byteLength <= MAX_FRAME_BYTES),
  })
  .strict();

const failureSchema = z
  .object({
    requestId: boundedIdSchema,
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    detail: z.string().min(1).max(2_000),
  })
  .strict();

export const frameContracts = {
  complete: defineInvokeContract<
    [{ scope: DerivedProjectScope; completion: FrameRenderCompletion }],
    void
  >({
    channel: invokeChannels.frames.complete,
    request: z.tuple([
      z.object({ scope: derivedProjectScopeSchema, completion: completionSchema }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  fail: defineInvokeContract<[{ scope: DerivedProjectScope; failure: FrameRenderFailure }], void>({
    channel: invokeChannels.frames.fail,
    request: z.tuple([
      z.object({ scope: derivedProjectScopeSchema, failure: failureSchema }).strict(),
    ]),
    privilege: "reversible-mutation",
  }),
} as const;

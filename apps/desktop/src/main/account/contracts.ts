import { z } from "zod";
import type { AccountSnapshot } from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { emptyRequestSchema } from "../app/ipc-schemas";

export const accountContracts = {
  get: defineInvokeContract<[], AccountSnapshot>({
    channel: invokeChannels.account.get,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  signIn: defineInvokeContract<[{ method: "email" | "google" }], void>({
    channel: invokeChannels.account.signIn,
    request: z.tuple([z.object({ method: z.enum(["email", "google"]) }).strict()]),
    privilege: "account",
  }),
  signOut: defineInvokeContract<[], AccountSnapshot>({
    channel: invokeChannels.account.signOut,
    request: emptyRequestSchema,
    privilege: "account",
  }),
} as const;

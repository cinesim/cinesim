import type { z } from "zod";

export type IpcPrivilege =
  | "read"
  | "reversible-mutation"
  | "canonical-command"
  | "destructive"
  | "account"
  | "process-launch"
  | "trust-change";

export interface InvokeContract<TArguments extends unknown[], TResult> {
  channel: string;
  request: z.ZodType<TArguments>;
  privilege: IpcPrivilege;
  readonly __result?: TResult;
}

export function defineInvokeContract<TArguments extends unknown[], TResult>(input: {
  channel: string;
  request: z.ZodType<TArguments>;
  privilege: IpcPrivilege;
}): InvokeContract<TArguments, TResult> {
  return input;
}

export type ContractArguments<TContract> =
  TContract extends InvokeContract<infer TArguments, unknown> ? TArguments : never;
export type ContractResult<TContract> =
  TContract extends InvokeContract<unknown[], infer TResult> ? TResult : never;

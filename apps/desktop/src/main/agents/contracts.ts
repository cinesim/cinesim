import { z } from "zod";
import type {
  AgentCreateInput,
  AgentEffort,
  AgentProjectSnapshot,
  AgentProviderKind,
  AgentProviderStatus,
  AgentSessionUpdate,
  AgentSettings,
  AgentSettingsUpdate,
  AgentTurnContext,
} from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { boundedIdSchema, desktopPathSchema, emptyRequestSchema } from "../app/ipc-schemas";

export const providerSchema = z.enum(["claude", "codex"]).pipe(z.custom<AgentProviderKind>());
const effortSchema = z
  .enum(["low", "medium", "high", "xhigh", "max"])
  .pipe(z.custom<AgentEffort>());
const permissionModeSchema = z.enum(["supervised", "auto-edit"]);
const providerSettingsShape = {
  model: z.string().max(120).optional(),
  effort: effortSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
};
const settingsUpdateSchema = z
  .object({
    defaultProvider: providerSchema.optional(),
    provider: providerSchema.optional(),
    ...providerSettingsShape,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.provider === undefined &&
      (input.model !== undefined ||
        input.effort !== undefined ||
        input.permissionMode !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Choose an agent provider before changing provider settings",
      });
    }
  })
  .pipe(z.custom<AgentSettingsUpdate>());
const createInputSchema = z
  .object({
    projectDirectory: desktopPathSchema,
    provider: providerSchema,
    ...providerSettingsShape,
  })
  .strict()
  .pipe(z.custom<AgentCreateInput>());
const turnContextSchema = z
  .object({
    activeSequenceId: boundedIdSchema.optional(),
    playheadUs: z.number().int().safe().nonnegative().optional(),
    selectedIds: z.array(boundedIdSchema).max(100).optional(),
  })
  .strict()
  .default({})
  .pipe(z.custom<AgentTurnContext>());
const sessionUpdateSchema = z
  .object(providerSettingsShape)
  .strict()
  .pipe(z.custom<AgentSessionUpdate>());

const snapshotContract = <TArguments extends unknown[]>(
  channel: string,
  request: z.ZodType<TArguments>,
  privilege: "read" | "reversible-mutation" | "trust-change" = "reversible-mutation",
) => defineInvokeContract<TArguments, AgentProjectSnapshot>({ channel, request, privilege });

export const agentContracts = {
  settingsGet: defineInvokeContract<[], AgentSettings>({
    channel: invokeChannels.agents.settingsGet,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  settingsUpdate: defineInvokeContract<[{ update: AgentSettingsUpdate }], AgentSettings>({
    channel: invokeChannels.agents.settingsUpdate,
    request: z.tuple([z.object({ update: settingsUpdateSchema }).strict()]),
    privilege: "trust-change",
  }),
  providersRefresh: defineInvokeContract<[], AgentProviderStatus[]>({
    channel: invokeChannels.agents.providersRefresh,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  executableChoose: defineInvokeContract<[{ provider: AgentProviderKind }], AgentSettings | null>({
    channel: invokeChannels.agents.executableChoose,
    request: z.tuple([z.object({ provider: providerSchema }).strict()]),
    privilege: "process-launch",
  }),
  login: defineInvokeContract<[{ provider: AgentProviderKind }], string>({
    channel: invokeChannels.agents.login,
    request: z.tuple([z.object({ provider: providerSchema }).strict()]),
    privilege: "process-launch",
  }),
  get: snapshotContract(
    invokeChannels.agents.get,
    z.tuple([z.object({ projectDirectory: desktopPathSchema }).strict()]),
    "read",
  ),
  create: snapshotContract(
    invokeChannels.agents.create,
    z.tuple([z.object({ input: createInputSchema }).strict()]),
    "trust-change",
  ),
  ensure: snapshotContract(
    invokeChannels.agents.ensure,
    z.tuple([z.object({ input: createInputSchema }).strict()]),
    "trust-change",
  ),
  update: snapshotContract(
    invokeChannels.agents.update,
    z.tuple([z.object({ sessionId: boundedIdSchema, update: sessionUpdateSchema }).strict()]),
    "trust-change",
  ),
  select: snapshotContract(
    invokeChannels.agents.select,
    z.tuple([
      z.object({ projectDirectory: desktopPathSchema, sessionId: boundedIdSchema }).strict(),
    ]),
  ),
  delete: snapshotContract(
    invokeChannels.agents.delete,
    z.tuple([
      z.object({ projectDirectory: desktopPathSchema, sessionId: boundedIdSchema }).strict(),
    ]),
  ),
  send: snapshotContract(
    invokeChannels.agents.send,
    z.tuple([
      z
        .object({
          sessionId: boundedIdSchema,
          message: z.string().min(1).max(100_000),
          context: turnContextSchema,
        })
        .strict(),
    ]),
  ),
  interrupt: snapshotContract(
    invokeChannels.agents.interrupt,
    z.tuple([z.object({ sessionId: boundedIdSchema }).strict()]),
  ),
  approval: snapshotContract(
    invokeChannels.agents.approval,
    z.tuple([
      z
        .object({
          sessionId: boundedIdSchema,
          requestId: boundedIdSchema,
          decision: z.enum(["accept", "decline"]),
        })
        .strict(),
    ]),
    "trust-change",
  ),
  revert: snapshotContract(
    invokeChannels.agents.revert,
    z.tuple([z.object({ sessionId: boundedIdSchema, turnId: boundedIdSchema }).strict()]),
    "trust-change",
  ),
} as const;

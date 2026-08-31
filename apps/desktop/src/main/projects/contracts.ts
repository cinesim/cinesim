import { z } from "zod";
import type { ProjectSettings, SemanticEditorCommand } from "@cinesim/core";
import { settingsSchema } from "@cinesim/core";
import { editorCommandSchema } from "@cinesim/protocol";
import { PROJECT_OPEN_TARGET_IDS } from "../../shared/contracts";
import type {
  CreateProjectLocation,
  DesktopAppState,
  DesktopCommandResult,
  DesktopProjectSession,
  ProjectOpenTarget,
  ProjectOpenTargetId,
  RecentProjectDetails,
} from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { desktopPathSchema, emptyRequestSchema } from "../app/ipc-schemas";

const sessionContract = <TArguments extends unknown[]>(
  channel: string,
  request: z.ZodType<TArguments>,
  privilege: "read" | "reversible-mutation" | "canonical-command" = "reversible-mutation",
) => defineInvokeContract<TArguments, DesktopProjectSession>({ channel, request, privilege });
const appStateContract = (channel: string, privilege: "reversible-mutation" | "destructive") =>
  defineInvokeContract<[{ directory: string }], DesktopAppState>({
    channel,
    request: z.tuple([z.object({ directory: desktopPathSchema }).strict()]),
    privilege,
  });

export const projectContracts = {
  chooseCreateLocation: defineInvokeContract<[], CreateProjectLocation | null>({
    channel: invokeChannels.project.chooseCreateLocation,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  create: defineInvokeContract<
    [{ name: string; kind: "local" | "cloud"; locationToken: string }],
    DesktopProjectSession | null
  >({
    channel: invokeChannels.project.create,
    request: z.tuple([
      z
        .object({
          name: z.string().trim().min(1).max(120),
          kind: z.enum(["local", "cloud"]),
          locationToken: z.uuid(),
        })
        .strict(),
    ]),
    privilege: "reversible-mutation",
  }),
  open: defineInvokeContract<[], DesktopProjectSession | null>({
    channel: invokeChannels.project.open,
    request: emptyRequestSchema,
    privilege: "reversible-mutation",
  }),
  openRecent: sessionContract(
    invokeChannels.project.openRecent,
    z.tuple([z.object({ directory: desktopPathSchema }).strict()]),
  ),
  session: defineInvokeContract<[], DesktopProjectSession | null>({
    channel: invokeChannels.project.session,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  recentDetails: defineInvokeContract<[], Record<string, RecentProjectDetails>>({
    channel: invokeChannels.project.recentDetails,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  save: sessionContract(invokeChannels.project.save, emptyRequestSchema, "canonical-command"),
  settingsUpdate: sessionContract(
    invokeChannels.project.settingsUpdate,
    z.tuple([
      z
        .object({ update: settingsSchema.partial() as z.ZodType<Partial<ProjectSettings>> })
        .strict(),
    ]),
    "canonical-command",
  ),
  undo: sessionContract(invokeChannels.project.undo, emptyRequestSchema, "canonical-command"),
  redo: sessionContract(invokeChannels.project.redo, emptyRequestSchema, "canonical-command"),
  openTargets: defineInvokeContract<[], ProjectOpenTarget[]>({
    channel: invokeChannels.project.openTargets,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  openWith: defineInvokeContract<[{ target: ProjectOpenTargetId }], void>({
    channel: invokeChannels.project.openWith,
    request: z.tuple([z.object({ target: z.enum(PROJECT_OPEN_TARGET_IDS) }).strict()]),
    privilege: "process-launch",
  }),
  forget: appStateContract(invokeChannels.project.forget, "reversible-mutation"),
  trash: appStateContract(invokeChannels.project.trash, "destructive"),
  importMedia: defineInvokeContract<[], DesktopProjectSession | null>({
    channel: invokeChannels.project.importMedia,
    request: emptyRequestSchema,
    privilege: "canonical-command",
  }),
  execute: defineInvokeContract<
    [{ command: SemanticEditorCommand; expectedGeneration?: string | undefined }],
    { session: DesktopProjectSession; result: DesktopCommandResult }
  >({
    channel: invokeChannels.project.execute,
    request: z.tuple([
      z
        .object({ command: editorCommandSchema, expectedGeneration: z.string().min(1).optional() })
        .strict(),
    ]),
    privilege: "canonical-command",
  }),
} as const;

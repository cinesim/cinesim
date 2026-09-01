import { z } from "zod";
import type { DesktopAppState, ElectronHealthSnapshot } from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import {
  parseCutLayoutState,
  parseEditorLayoutState,
  parseNewProjectSettings,
  parseTranscriptionSettings,
} from "../state/app-state-store";
import { defineInvokeContract } from "./ipc-contract";
import { emptyRequestSchema } from "./ipc-schemas";

const stateResult = <TArguments extends unknown[]>(
  channel: string,
  request: z.ZodType<TArguments>,
) =>
  defineInvokeContract<TArguments, DesktopAppState>({
    channel,
    request,
    privilege: "reversible-mutation",
  });

export const appContracts = {
  health: defineInvokeContract<[], ElectronHealthSnapshot>({
    channel: invokeChannels.app.health,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  stateGet: defineInvokeContract<[], DesktopAppState>({
    channel: invokeChannels.appState.get,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  setMediaPoolOpen: stateResult(
    invokeChannels.appState.setMediaPoolOpen,
    z.tuple([z.object({ open: z.boolean() }).strict()]),
  ),
  setInspectorOpen: stateResult(
    invokeChannels.appState.setInspectorOpen,
    z.tuple([z.object({ open: z.boolean() }).strict()]),
  ),
  setNotesOpen: stateResult(
    invokeChannels.appState.setNotesOpen,
    z.tuple([z.object({ open: z.boolean() }).strict()]),
  ),
  setEditorLayout: stateResult(
    invokeChannels.appState.setEditorLayout,
    z.tuple([
      z
        .object({ layout: z.unknown() })
        .strict()
        .transform(({ layout }, context) => {
          const result = parseEditorLayoutState(layout);
          if (result) return { layout: result };
          context.addIssue({ code: "custom", message: "Invalid editor layout" });
          return z.NEVER;
        }),
    ]),
  ),
  setCutLayout: stateResult(
    invokeChannels.appState.setCutLayout,
    z.tuple([
      z
        .object({ layout: z.unknown() })
        .strict()
        .transform(({ layout }, context) => {
          const result = parseCutLayoutState(layout);
          if (result) return { layout: result };
          context.addIssue({ code: "custom", message: "Invalid Cut layout" });
          return z.NEVER;
        }),
    ]),
  ),
  setTranscriptionSettings: stateResult(
    invokeChannels.appState.setTranscriptionSettings,
    z.tuple([
      z
        .object({ settings: z.unknown() })
        .strict()
        .transform(({ settings }, context) => {
          const result = parseTranscriptionSettings(settings);
          if (result) return { settings: result };
          context.addIssue({ code: "custom", message: "Invalid transcription settings" });
          return z.NEVER;
        }),
    ]),
  ),
  setNewProjectSettings: stateResult(
    invokeChannels.appState.setNewProjectSettings,
    z.tuple([
      z
        .object({ settings: z.unknown() })
        .strict()
        .transform(({ settings }, context) => {
          const result = parseNewProjectSettings(settings);
          if (result) return { settings: result };
          context.addIssue({ code: "custom", message: "Invalid new-project settings" });
          return z.NEVER;
        }),
    ]),
  ),
} as const;

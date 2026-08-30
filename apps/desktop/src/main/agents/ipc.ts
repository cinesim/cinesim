import { execFile } from "node:child_process";
import { clipboard, dialog } from "electron";
import { z } from "zod";
import type {
  AgentCreateInput,
  AgentProviderKind,
  AgentSessionUpdate,
  AgentSettingsUpdate,
  AgentTurnContext,
} from "../../shared/api";
import type { AgentManager } from "./manager";
import { detectProvider } from "./provider-detection";
import type { AgentSettingsStore } from "./settings-store";
import { registerIpcHandler } from "../app/secure-ipc";

const providerSchema = z.enum(["claude", "codex"]).pipe(z.custom<AgentProviderKind>());
const effortSchema = z
  .enum(["low", "medium", "high", "xhigh", "max"])
  .pipe(z.custom<NonNullable<AgentSessionUpdate["effort"]>>());
const permissionModeSchema = z.enum(["supervised", "auto-edit"]);
const providerSettingsShape = {
  model: z.string().max(120).optional(),
  effort: effortSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
};
const agentSettingsUpdateSchema = z
  .object({
    defaultProvider: providerSchema.optional(),
    provider: providerSchema.optional(),
    executablePath: z.string().max(4096).optional(),
    ...providerSettingsShape,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.provider === undefined &&
      (input.executablePath !== undefined ||
        input.model !== undefined ||
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
const agentCreateInputSchema = z
  .object({
    projectDirectory: z.string().min(1).max(4096),
    provider: providerSchema,
    ...providerSettingsShape,
  })
  .strict()
  .pipe(z.custom<AgentCreateInput>());
const agentTurnContextSchema = z
  .object({
    activeSequenceId: z.string().max(200).optional(),
    playheadUs: z.number().int().safe().nonnegative().optional(),
    selectedIds: z.array(z.string().max(200)).max(100).optional(),
  })
  .strict()
  .pipe(z.custom<AgentTurnContext>());
const agentSessionUpdateSchema = z
  .object(providerSettingsShape)
  .strict()
  .pipe(z.custom<AgentSessionUpdate>());

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseAgentSettingsUpdate(value: unknown): AgentSettingsUpdate {
  return agentSettingsUpdateSchema.parse(value);
}

function parseAgentCreateInput(value: unknown): AgentCreateInput {
  return agentCreateInputSchema.parse(value);
}

function parseAgentTurnContext(value: unknown): AgentTurnContext {
  return agentTurnContextSchema.parse(value ?? {});
}

function parseAgentSessionUpdate(value: unknown): AgentSessionUpdate {
  return agentSessionUpdateSchema.parse(value);
}

export function registerAgentIpc(agents: AgentManager, settingsStore: AgentSettingsStore): void {
  registerIpcHandler("agents:settings:get", () => settingsStore.snapshot());
  registerIpcHandler("agents:settings:update", (update: unknown) =>
    settingsStore.update(parseAgentSettingsUpdate(update)),
  );
  registerIpcHandler("agents:providers:refresh", async () => {
    const settings = settingsStore.snapshot();
    const statuses = await Promise.all(
      (["claude", "codex"] as const).map((provider) =>
        detectProvider(provider, settings.providers[provider]),
      ),
    );
    for (const status of statuses) {
      if (!settings.providers[status.provider].executablePath && status.executablePath)
        await settingsStore.update({
          provider: status.provider,
          executablePath: status.executablePath,
        });
    }
    return statuses;
  });
  registerIpcHandler("agents:executable:choose", async (provider: unknown) => {
    const parsedProvider = providerSchema.parse(provider);
    const selection = await dialog.showOpenDialog({
      title: `Choose ${parsedProvider === "claude" ? "Claude Code" : "Codex"} executable`,
      buttonLabel: "Use executable",
      properties: ["openFile"],
    });
    if (selection.canceled) return null;
    return settingsStore.update({
      provider: parsedProvider,
      executablePath: selection.filePaths[0]!,
    });
  });
  registerIpcHandler("agents:login", async (provider: unknown) => {
    const parsedProvider = providerSchema.parse(provider);
    const configured = settingsStore.snapshot().providers[parsedProvider].executablePath;
    const executable = configured || parsedProvider;
    const command = `${quoteShellArgument(executable)} ${parsedProvider === "claude" ? "/login" : "login"}`;
    clipboard.writeText(command);
    await new Promise<void>((resolve) => {
      execFile("open", ["-a", "Terminal"], () => resolve());
    });
    return `Copied “${command}” and opened Terminal. Paste it there to finish signing in.`;
  });
  registerIpcHandler("agents:get", (projectDirectory: unknown) => {
    if (typeof projectDirectory !== "string") throw new Error("Invalid project directory");
    return agents.snapshot(projectDirectory);
  });
  registerIpcHandler("agents:create", (input: unknown) =>
    agents.create(parseAgentCreateInput(input)),
  );
  registerIpcHandler("agents:ensure", (input: unknown) =>
    agents.ensure(parseAgentCreateInput(input)),
  );
  registerIpcHandler("agents:update", (sessionId: unknown, update: unknown) => {
    if (typeof sessionId !== "string") throw new Error("Invalid agent session");
    return agents.update(sessionId, parseAgentSessionUpdate(update));
  });
  registerIpcHandler("agents:select", (projectDirectory: unknown, sessionId: unknown) => {
    if (typeof projectDirectory !== "string" || typeof sessionId !== "string")
      throw new Error("Invalid agent selection");
    return agents.select(projectDirectory, sessionId);
  });
  registerIpcHandler("agents:delete", (projectDirectory: unknown, sessionId: unknown) => {
    if (typeof projectDirectory !== "string" || typeof sessionId !== "string")
      throw new Error("Invalid agent deletion");
    return agents.delete(projectDirectory, sessionId);
  });
  registerIpcHandler("agents:send", (sessionId: unknown, message: unknown, context: unknown) => {
    if (typeof sessionId !== "string" || typeof message !== "string")
      throw new Error("Invalid agent message");
    return agents.send(sessionId, message, parseAgentTurnContext(context));
  });
  registerIpcHandler("agents:interrupt", (sessionId: unknown) => {
    if (typeof sessionId !== "string") throw new Error("Invalid agent session");
    return agents.interrupt(sessionId);
  });
  registerIpcHandler(
    "agents:approval",
    (sessionId: unknown, requestId: unknown, decision: unknown) => {
      if (
        typeof sessionId !== "string" ||
        typeof requestId !== "string" ||
        (decision !== "accept" && decision !== "decline")
      )
        throw new Error("Invalid approval response");
      return agents.respondApproval(sessionId, requestId, decision);
    },
  );
  registerIpcHandler("agents:revert", (sessionId: unknown, turnId: unknown) => {
    if (typeof sessionId !== "string" || typeof turnId !== "string")
      throw new Error("Invalid checkpoint selection");
    return agents.revert(sessionId, turnId);
  });
}

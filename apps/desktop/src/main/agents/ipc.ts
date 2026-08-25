import { execFile } from "node:child_process";
import { clipboard, dialog, ipcMain } from "electron";
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

function isProvider(value: unknown): value is AgentProviderKind {
  return value === "claude" || value === "codex";
}

function isAgentEffort(value: unknown): value is NonNullable<AgentSessionUpdate["effort"]> {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseAgentSettingsUpdate(value: unknown): AgentSettingsUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid agent settings");
  const input = value as Record<string, unknown>;
  if (input.defaultProvider !== undefined && !isProvider(input.defaultProvider))
    throw new Error("Invalid default agent provider");
  if (input.provider !== undefined && !isProvider(input.provider))
    throw new Error("Invalid agent provider");
  if (
    input.executablePath !== undefined &&
    (typeof input.executablePath !== "string" || input.executablePath.length > 4096)
  )
    throw new Error("Invalid agent executable path");
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.length > 120))
    throw new Error("Invalid agent model");
  if (
    input.permissionMode !== undefined &&
    input.permissionMode !== "supervised" &&
    input.permissionMode !== "auto-edit"
  )
    throw new Error("Invalid agent approval mode");
  if (input.effort !== undefined && !isAgentEffort(input.effort))
    throw new Error("Invalid agent reasoning effort");
  if (
    (input.executablePath !== undefined ||
      input.model !== undefined ||
      input.effort !== undefined ||
      input.permissionMode !== undefined) &&
    !isProvider(input.provider)
  )
    throw new Error("Choose an agent provider before changing provider settings");
  return {
    ...(isProvider(input.defaultProvider) ? { defaultProvider: input.defaultProvider } : {}),
    ...(isProvider(input.provider) ? { provider: input.provider } : {}),
    ...(typeof input.executablePath === "string" ? { executablePath: input.executablePath } : {}),
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    ...(isAgentEffort(input.effort) ? { effort: input.effort } : {}),
    ...(input.permissionMode === "supervised" || input.permissionMode === "auto-edit"
      ? { permissionMode: input.permissionMode }
      : {}),
  };
}

function parseAgentCreateInput(value: unknown): AgentCreateInput {
  const input = parseAgentSettingsUpdate(value);
  const record = value as Record<string, unknown>;
  if (
    typeof record.projectDirectory !== "string" ||
    record.projectDirectory.length === 0 ||
    record.projectDirectory.length > 4096 ||
    !isProvider(record.provider)
  )
    throw new Error("Invalid new agent");
  return {
    projectDirectory: record.projectDirectory,
    provider: record.provider,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
  };
}

function parseAgentTurnContext(value: unknown): AgentTurnContext {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid agent turn context");
  const input = value as Record<string, unknown>;
  if (input.activeSequenceId !== undefined && typeof input.activeSequenceId !== "string")
    throw new Error("Invalid active sequence");
  if (
    input.playheadUs !== undefined &&
    (typeof input.playheadUs !== "number" ||
      !Number.isSafeInteger(input.playheadUs) ||
      input.playheadUs < 0)
  )
    throw new Error("Invalid playhead time");
  if (
    input.selectedIds !== undefined &&
    (!Array.isArray(input.selectedIds) ||
      input.selectedIds.length > 100 ||
      input.selectedIds.some((id) => typeof id !== "string" || id.length > 200))
  )
    throw new Error("Invalid agent selection context");
  return {
    ...(typeof input.activeSequenceId === "string"
      ? { activeSequenceId: input.activeSequenceId }
      : {}),
    ...(typeof input.playheadUs === "number" ? { playheadUs: input.playheadUs } : {}),
    ...(Array.isArray(input.selectedIds) ? { selectedIds: input.selectedIds as string[] } : {}),
  };
}

function parseAgentSessionUpdate(value: unknown): AgentSessionUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid agent session settings");
  const input = value as Record<string, unknown>;
  const parsed = parseAgentSettingsUpdate({
    provider: "claude",
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
  });
  return {
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.effort ? { effort: parsed.effort } : {}),
    ...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
  };
}

export function registerAgentIpc(agents: AgentManager, settingsStore: AgentSettingsStore): void {
  ipcMain.handle("agents:settings:get", () => settingsStore.snapshot());
  ipcMain.handle("agents:settings:update", (_event, update: unknown) =>
    settingsStore.update(parseAgentSettingsUpdate(update)),
  );
  ipcMain.handle("agents:providers:refresh", async () => {
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
  ipcMain.handle("agents:executable:choose", async (_event, provider: AgentProviderKind) => {
    if (!isProvider(provider)) throw new Error("Invalid agent provider");
    const selection = await dialog.showOpenDialog({
      title: `Choose ${provider === "claude" ? "Claude Code" : "Codex"} executable`,
      buttonLabel: "Use executable",
      properties: ["openFile"],
    });
    if (selection.canceled) return null;
    return settingsStore.update({ provider, executablePath: selection.filePaths[0]! });
  });
  ipcMain.handle("agents:login", async (_event, provider: AgentProviderKind) => {
    if (!isProvider(provider)) throw new Error("Invalid agent provider");
    const configured = settingsStore.snapshot().providers[provider].executablePath;
    const executable = configured || provider;
    const command = `${quoteShellArgument(executable)} ${provider === "claude" ? "/login" : "login"}`;
    clipboard.writeText(command);
    await new Promise<void>((resolve) => {
      execFile("open", ["-a", "Terminal"], () => resolve());
    });
    return `Copied “${command}” and opened Terminal. Paste it there to finish signing in.`;
  });
  ipcMain.handle("agents:get", (_event, projectDirectory: unknown) => {
    if (typeof projectDirectory !== "string") throw new Error("Invalid project directory");
    return agents.snapshot(projectDirectory);
  });
  ipcMain.handle("agents:create", (_event, input: unknown) =>
    agents.create(parseAgentCreateInput(input)),
  );
  ipcMain.handle("agents:ensure", (_event, input: unknown) =>
    agents.ensure(parseAgentCreateInput(input)),
  );
  ipcMain.handle("agents:update", (_event, sessionId: unknown, update: unknown) => {
    if (typeof sessionId !== "string") throw new Error("Invalid agent session");
    return agents.update(sessionId, parseAgentSessionUpdate(update));
  });
  ipcMain.handle("agents:select", (_event, projectDirectory: unknown, sessionId: unknown) => {
    if (typeof projectDirectory !== "string" || typeof sessionId !== "string")
      throw new Error("Invalid agent selection");
    return agents.select(projectDirectory, sessionId);
  });
  ipcMain.handle("agents:delete", (_event, projectDirectory: unknown, sessionId: unknown) => {
    if (typeof projectDirectory !== "string" || typeof sessionId !== "string")
      throw new Error("Invalid agent deletion");
    return agents.delete(projectDirectory, sessionId);
  });
  ipcMain.handle(
    "agents:send",
    (_event, sessionId: unknown, message: unknown, context: unknown) => {
      if (typeof sessionId !== "string" || typeof message !== "string")
        throw new Error("Invalid agent message");
      return agents.send(sessionId, message, parseAgentTurnContext(context));
    },
  );
  ipcMain.handle("agents:interrupt", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string") throw new Error("Invalid agent session");
    return agents.interrupt(sessionId);
  });
  ipcMain.handle(
    "agents:approval",
    (_event, sessionId: unknown, requestId: unknown, decision: unknown) => {
      if (
        typeof sessionId !== "string" ||
        typeof requestId !== "string" ||
        (decision !== "accept" && decision !== "decline")
      )
        throw new Error("Invalid approval response");
      return agents.respondApproval(sessionId, requestId, decision);
    },
  );
  ipcMain.handle("agents:revert", (_event, sessionId: unknown, turnId: unknown) => {
    if (typeof sessionId !== "string" || typeof turnId !== "string")
      throw new Error("Invalid checkpoint selection");
    return agents.revert(sessionId, turnId);
  });
}

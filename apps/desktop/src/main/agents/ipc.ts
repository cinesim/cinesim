import { execFile } from "node:child_process";
import { clipboard, dialog } from "electron";
import type { AgentProviderKind } from "../../shared/contracts";
import type { AgentManager } from "./manager";
import { detectProvider } from "./provider-detection";
import { inspectAgentExecutable } from "./executable-trust";
import type { AgentSettingsStore } from "./settings-store";
import { registerIpcHandler } from "../app/secure-ipc";
import { requireUserIntent } from "../app/user-intent";
import { agentContracts } from "./contracts";

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function registerAgentIpc(agents: AgentManager, settingsStore: AgentSettingsStore): void {
  registerIpcHandler(agentContracts.settingsGet, () => settingsStore.snapshot());
  registerIpcHandler(agentContracts.settingsUpdate, async ({ update }) => {
    if (update.provider && update.permissionMode === "auto-edit") {
      await requireUserIntent({
        title: "Allow automatic edits?",
        message: `Let ${update.provider === "claude" ? "Claude Code" : "Codex"} edit the open project without individual approvals?`,
        detail:
          "This trust setting applies to new sessions. You can return to supervised mode at any time.",
        confirmLabel: "Enable auto-edit",
      });
    }
    return settingsStore.update(update);
  });
  registerIpcHandler(agentContracts.providersRefresh, async () => {
    const settings = settingsStore.snapshot();
    const statuses = await Promise.all(
      (["claude", "codex"] as const).map((provider) =>
        detectProvider(provider, settings.providers[provider]),
      ),
    );
    for (const status of statuses) {
      if (!settings.providers[status.provider].executablePath && status.executablePath)
        await settingsStore.trustExecutable(status.provider, status.executablePath);
    }
    return statuses;
  });
  registerIpcHandler(agentContracts.executableChoose, async ({ provider: parsedProvider }) => {
    const selection = await dialog.showOpenDialog({
      title: `Choose ${parsedProvider === "claude" ? "Claude Code" : "Codex"} executable`,
      buttonLabel: "Use executable",
      properties: ["openFile"],
    });
    if (selection.canceled) return null;
    const identity = await inspectAgentExecutable(selection.filePaths[0]!);
    await requireUserIntent({
      title: "Trust agent executable?",
      message: `Use this ${parsedProvider === "claude" ? "Claude Code" : "Codex"} executable?`,
      detail: identity.path,
      confirmLabel: "Trust executable",
    });
    return settingsStore.trustExecutable(parsedProvider, identity.path);
  });
  registerIpcHandler(agentContracts.login, async ({ provider: parsedProvider }) => {
    const executable = await settingsStore.requireTrustedExecutable(parsedProvider);
    const command = `${quoteShellArgument(executable)} ${parsedProvider === "claude" ? "/login" : "login"}`;
    clipboard.writeText(command);
    await new Promise<void>((resolve) => {
      execFile("open", ["-a", "Terminal"], () => resolve());
    });
    return `Copied “${command}” and opened Terminal. Paste it there to finish signing in.`;
  });
  registerIpcHandler(agentContracts.get, ({ projectDirectory }) =>
    agents.snapshot(projectDirectory),
  );
  registerIpcHandler(agentContracts.create, async ({ input }) => {
    if (input.permissionMode === "auto-edit") await confirmSessionAutoEdit(input.provider);
    return agents.create(input);
  });
  registerIpcHandler(agentContracts.ensure, async ({ input }) => {
    if (input.permissionMode === "auto-edit") await confirmSessionAutoEdit(input.provider);
    return agents.ensure(input);
  });
  registerIpcHandler(agentContracts.update, async ({ sessionId, update }) => {
    if (update.permissionMode === "auto-edit") await confirmSessionAutoEdit();
    return agents.update(sessionId, update);
  });
  registerIpcHandler(agentContracts.select, ({ projectDirectory, sessionId }) => {
    return agents.select(projectDirectory, sessionId);
  });
  registerIpcHandler(agentContracts.delete, ({ projectDirectory, sessionId }) => {
    return agents.delete(projectDirectory, sessionId);
  });
  registerIpcHandler(agentContracts.send, ({ sessionId, message, context }) => {
    return agents.send(sessionId, message, context);
  });
  registerIpcHandler(agentContracts.interrupt, ({ sessionId }) => {
    return agents.interrupt(sessionId);
  });
  registerIpcHandler(agentContracts.approval, async ({ sessionId, requestId, decision }) => {
    if (decision === "accept") {
      const intent = agents.approvalIntent(sessionId, requestId);
      await requireUserIntent({
        title: "Approve agent operation?",
        message: `Allow ${intent.toolName.replaceAll("_", " ")}?`,
        detail: intent.detail,
        confirmLabel: "Approve once",
      });
    }
    return agents.respondApproval(sessionId, requestId, decision);
  });
}

async function confirmSessionAutoEdit(provider?: AgentProviderKind): Promise<void> {
  await requireUserIntent({
    title: "Allow automatic edits?",
    message: `Let ${provider ? (provider === "claude" ? "Claude Code" : "Codex") : "this agent"} edit the open project without individual approvals?`,
    detail:
      "Automatic edits can change canonical project files in the project-local sandbox. Valid generations enter project undo history, but individual file changes will not ask first.",
    confirmLabel: "Enable auto-edit",
  });
}

import { execFile } from "node:child_process";
import { clipboard, dialog } from "electron";
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
  registerIpcHandler(agentContracts.settingsUpdate, ({ update }) => settingsStore.update(update));
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
  registerIpcHandler(agentContracts.create, ({ input }) => agents.create(input));
  registerIpcHandler(agentContracts.ensure, ({ input }) => agents.ensure(input));
  registerIpcHandler(agentContracts.update, ({ sessionId, update }) =>
    agents.update(sessionId, update),
  );
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
}

import { join } from "node:path";
import { execFile } from "node:child_process";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  shell,
} from "electron";
import type { EditorCommand } from "@cinesim/core";
import type {
  AgentCreateInput,
  AgentProviderKind,
  AgentSessionUpdate,
  AgentSettingsUpdate,
  AgentTurnContext,
} from "../shared/api";
import { AgentManager } from "./agent-manager";
import { detectProvider } from "./agent-provider-detection";
import { AgentSettingsStore } from "./agent-settings-store";
import { DesktopAppStateStore } from "./app-state-store";
import { DesktopProjectStore } from "./project-store";

const store = new DesktopProjectStore();
let appState: DesktopAppStateStore;
let agentSettings: AgentSettingsStore;
let agents: AgentManager;
let quitReady = false;
let shutdown: Promise<void> | null = null;

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

protocol.registerSchemesAsPrivileged([
  {
    scheme: "cinesim-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#f9f9f9",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: join(app.getAppPath(), "dist/preload/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("before-input-event", (event, input) => {
    const closeTabModifier = process.platform === "darwin" ? input.meta : input.control;
    if (
      input.type === "keyDown" &&
      closeTabModifier &&
      !input.alt &&
      !input.shift &&
      input.key.toLowerCase() === "w"
    ) {
      event.preventDefault();
      window.webContents.send("app:close-active-tab");
    }
  });

  const developmentUrl = process.env.CINESIM_DEV_SERVER_URL;
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(join(app.getAppPath(), "dist/renderer/index.html"));
  return window;
}

async function registerMediaProtocol(): Promise<void> {
  protocol.handle("cinesim-media", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "asset") return new Response("Not found", { status: 404 });
      const assetId = url.pathname.slice(1);
      if (!/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(assetId))
        return new Response("Bad asset ID", { status: 400 });
      const range = request.headers.get("range");
      const path = store.assetPath(assetId);
      if (!path) return new Response("Unknown asset", { status: 404 });
      const fileSize = (await import("node:fs/promises")).stat(path).then((value) => value.size);
      const size = await fileSize;
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Content-Length": String(size),
            "Content-Type": "application/octet-stream",
          },
        });
      }
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = match ? Number(match[1]) : 0;
      const requestedEnd = match?.[2]
        ? Number(match[2]) + 1
        : Math.min(size, start + 16 * 1024 * 1024);
      const { data } = await store.readRange(assetId, start, requestedEnd);
      const end = start + data.byteLength;
      return new Response(request.method === "HEAD" ? null : new Uint8Array(data), {
        status: range || data.byteLength < size ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
          "Content-Length": String(data.byteLength),
          ...(range || data.byteLength < size
            ? { "Content-Range": `bytes ${start}-${Math.max(start, end - 1)}/${size}` }
            : {}),
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "Media read failed", {
        status: 500,
      });
    }
  });
}

function registerIpc(): void {
  ipcMain.handle("project:create", async (_event, name: unknown) => {
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 120)
      throw new Error("Invalid project name");
    const selection = await dialog.showOpenDialog({
      title: "Choose a parent folder for the new Cinesim project",
      buttonLabel: "Create here",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled) return null;
    const session = await store.create(selection.filePaths[0]!, name);
    await appState.rememberProject({ name: session.project.name, directory: session.directory });
    return session;
  });
  ipcMain.handle("project:open", async () => {
    const selection = await dialog.showOpenDialog({
      title: "Open a Cinesim project",
      buttonLabel: "Open project",
      properties: ["openDirectory"],
    });
    if (selection.canceled) return null;
    const session = await store.open(selection.filePaths[0]!);
    await appState.rememberProject({ name: session.project.name, directory: session.directory });
    return session;
  });
  ipcMain.handle("project:open-recent", async (_event, directory: unknown) => {
    if (typeof directory !== "string" || !appState.hasRecent(directory))
      throw new Error("Project is not in the recent projects list");
    const session = await store.open(directory);
    await appState.rememberProject({ name: session.project.name, directory: session.directory });
    return session;
  });
  ipcMain.handle("project:session", () => (store.project ? store.session() : null));
  ipcMain.handle("project:save", () => store.save());
  ipcMain.handle("project:undo", () => store.undo());
  ipcMain.handle("project:redo", () => store.redo());
  ipcMain.handle("project:reveal", () =>
    store.directory ? shell.openPath(store.directory) : undefined,
  );
  ipcMain.handle("media:import", async () => {
    if (!store.project) throw new Error("Open a project before importing media");
    const selection = await dialog.showOpenDialog({
      title: "Import media",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Media",
          extensions: ["mp4", "mov", "m4v", "webm", "mkv", "mp3", "wav", "flac"],
        },
      ],
    });
    if (selection.canceled) return null;
    let session = store.session();
    for (const filePath of selection.filePaths)
      session = await store.inspectAndImportMedia(filePath);
    return session;
  });
  ipcMain.handle("command:execute", (_event, command: EditorCommand) => store.execute(command));
  ipcMain.handle("app-state:get", () => appState.snapshot());
  ipcMain.handle("app-state:set-project-view", async (_event, candidate: unknown) => {
    const directory = store.directory;
    const project = store.project;
    if (!directory || !project || typeof candidate !== "object" || candidate === null)
      throw new Error("Open a project before changing its view");
    const view = candidate as Record<string, unknown>;
    const validIds = new Set<string>(project.sequences.map((sequence) => sequence.id));
    if (
      !Array.isArray(view.openSequenceIds) ||
      view.openSequenceIds.length > project.sequences.length ||
      view.openSequenceIds.some((id) => typeof id !== "string" || !validIds.has(id)) ||
      typeof view.activeTab !== "string"
    )
      throw new Error("Invalid open timeline list");
    const openSequenceIds = [...new Set<string>(view.openSequenceIds)];
    const activeTab =
      view.activeTab === "media" || openSequenceIds.includes(view.activeTab)
        ? view.activeTab
        : "media";
    await appState.setProjectView(directory, { openSequenceIds, activeTab });
    return appState.snapshot();
  });
  ipcMain.handle("agents:settings:get", () => agentSettings.snapshot());
  ipcMain.handle("agents:settings:update", (_event, update: unknown) =>
    agentSettings.update(parseAgentSettingsUpdate(update)),
  );
  ipcMain.handle("agents:providers:refresh", async () => {
    const settings = agentSettings.snapshot();
    const statuses = await Promise.all(
      (["claude", "codex"] as const).map((provider) =>
        detectProvider(provider, settings.providers[provider]),
      ),
    );
    for (const status of statuses) {
      if (!settings.providers[status.provider].executablePath && status.executablePath)
        await agentSettings.update({
          provider: status.provider,
          executablePath: status.executablePath,
        });
    }
    return statuses;
  });
  ipcMain.handle("agents:executable:choose", async (_event, provider: AgentProviderKind) => {
    if (provider !== "claude" && provider !== "codex") throw new Error("Invalid agent provider");
    const selection = await dialog.showOpenDialog({
      title: `Choose ${provider === "claude" ? "Claude Code" : "Codex"} executable`,
      buttonLabel: "Use executable",
      properties: ["openFile"],
    });
    if (selection.canceled) return null;
    return agentSettings.update({ provider, executablePath: selection.filePaths[0]! });
  });
  ipcMain.handle("agents:login", async (_event, provider: AgentProviderKind) => {
    if (provider !== "claude" && provider !== "codex") throw new Error("Invalid agent provider");
    const configured = agentSettings.snapshot().providers[provider].executablePath;
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

async function startApplication(): Promise<void> {
  await app.whenReady();
  appState = new DesktopAppStateStore(join(app.getPath("userData"), "ui-state.json"));
  agentSettings = new AgentSettingsStore(join(app.getPath("userData"), "agent-settings.json"));
  await appState.load();
  await agentSettings.load();
  await registerMediaProtocol();
  agents = new AgentManager(
    join(app.getPath("userData"), "agent-sessions.json"),
    agentSettings,
    store,
    (snapshot) => {
      for (const target of BrowserWindow.getAllWindows())
        target.webContents.send("agents:changed", snapshot);
    },
    () => {
      if (!store.project) return;
      const session = store.session();
      for (const target of BrowserWindow.getAllWindows())
        target.webContents.send("project:changed", session);
    },
  );
  await agents.load();
  registerIpc();
  const window = createWindow();
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

void startApplication().catch((error: unknown) => {
  console.error("Cinesim failed to start", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitReady || !agents) return;
  event.preventDefault();
  shutdown ??= agents
    .close()
    .catch((error: unknown) => console.error("Cinesim agent shutdown failed", error))
    .then(() => {
      quitReady = true;
      app.quit();
    });
});

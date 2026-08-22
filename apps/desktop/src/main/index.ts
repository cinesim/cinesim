import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, shell } from "electron";
import type { EditorCommand } from "@cinesim/core";
import { DesktopAppStateStore } from "./app-state-store";
import { DesktopProjectStore } from "./project-store";

const store = new DesktopProjectStore();
let appState: DesktopAppStateStore;

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
}

async function startApplication(): Promise<void> {
  await app.whenReady();
  appState = new DesktopAppStateStore(join(app.getPath("userData"), "ui-state.json"));
  await appState.load();
  await registerMediaProtocol();
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

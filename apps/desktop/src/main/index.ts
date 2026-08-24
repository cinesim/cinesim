import { join } from "node:path";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
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
import { createCinesimLogger } from "@cinesim/logging";
import type {
  AgentCreateInput,
  AgentProviderKind,
  AgentSessionUpdate,
  AgentSettingsUpdate,
  AgentTurnContext,
  BeginDerivedWrite,
  DerivedArtifactKind,
  DerivedPerformanceObservation,
  DerivedWorkerActivity,
  DerivedWorkerStage,
  FinalizeDerivedWrite,
} from "../shared/api";
import { AgentManager } from "./agent-manager";
import { detectProvider } from "./agent-provider-detection";
import { AgentSettingsStore } from "./agent-settings-store";
import { DesktopAppStateStore, parseEditorLayoutState } from "./app-state-store";
import { DesktopProjectStore } from "./project-store";

const store = new DesktopProjectStore();
const log = createCinesimLogger({ service: "desktop" });
const DERIVED_WORKER_STAGES = new Set<DerivedWorkerStage>([
  "scheduled",
  "input-opening",
  "container-ready",
  "track-ready",
  "decoder-ready",
  "thumbnail-sampling",
  "thumbnail-encoding",
  "thumbnail-ready",
  "filmstrip-sampling",
  "filmstrip-encoding",
  "filmstrip-ready",
  "proxy-converting",
  "completed",
  "failed",
]);
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

function parseDerivedWorkerActivity(value: unknown): DerivedWorkerActivity {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid derived worker activity");
  const input = value as Record<string, unknown>;
  if (
    typeof input.jobId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.jobId) ||
    typeof input.assetId !== "string" ||
    !/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.assetId) ||
    (input.jobKind !== "perception" && input.jobKind !== "proxy") ||
    typeof input.stage !== "string" ||
    !DERIVED_WORKER_STAGES.has(input.stage as DerivedWorkerStage) ||
    typeof input.elapsedMs !== "number" ||
    !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs < 0 ||
    input.elapsedMs > 86_400_000
  )
    throw new Error("Invalid derived worker activity");
  for (const sample of [input.completedSamples, input.totalSamples]) {
    if (sample !== undefined && (!Number.isSafeInteger(sample) || (sample as number) < 0))
      throw new Error("Invalid derived worker sample count");
  }
  if (
    input.failureCode !== undefined &&
    (typeof input.failureCode !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.failureCode))
  )
    throw new Error("Invalid derived worker failure code");
  if (
    input.detail !== undefined &&
    (typeof input.detail !== "string" || input.detail.length > 2_000)
  )
    throw new Error("Invalid derived worker detail");
  return input as unknown as DerivedWorkerActivity;
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
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 1080,
    minHeight: 700,
    show: false,
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
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const developmentUrl = process.env.CINESIM_DEV_SERVER_URL;
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(join(app.getAppPath(), "dist/renderer/index.html"));
  return window;
}

function streamedMediaResponse(input: {
  path: string;
  size: number;
  mimeType: string;
  assetId: string;
  start: number;
  endExclusive: number;
  range: boolean;
  cacheControl: string;
  requestStarted: number;
}): Response {
  const start = Math.max(0, Math.min(input.start, input.size));
  const endExclusive = Math.max(start, Math.min(input.endExclusive, input.size));
  const length = endExclusive - start;
  const headers = {
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": String(length),
    ...(input.range
      ? { "Content-Range": `bytes ${start}-${Math.max(start, endExclusive - 1)}/${input.size}` }
      : {}),
    "Content-Type": input.mimeType,
    "Cache-Control": input.cacheControl,
  };
  if (length === 0) {
    store.derivedMedia.recordProtocolRead({
      assetId: input.assetId,
      start,
      requestedEnd: endExclusive,
      bytesRead: 0,
      durationMs: performance.now() - input.requestStarted,
      range: input.range,
    });
    return new Response(null, { status: input.range ? 206 : 200, headers });
  }
  const stream = createReadStream(input.path, {
    start,
    end: endExclusive - 1,
    highWaterMark: 64 * 1024,
  });
  let settled = false;
  const recordRead = () => {
    if (settled) return;
    settled = true;
    store.derivedMedia.recordProtocolRead({
      assetId: input.assetId,
      start,
      requestedEnd: endExclusive,
      bytesRead: stream.bytesRead,
      durationMs: performance.now() - input.requestStarted,
      range: input.range,
    });
  };
  stream.once("error", (error) => {
    if (error.name === "AbortError") {
      recordRead();
      return;
    }
    settled = true;
    store.derivedMedia.recordProtocolError(
      input.assetId,
      error.message,
      performance.now() - input.requestStarted,
    );
  });
  stream.once("close", recordRead);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: input.range ? 206 : 200,
    headers,
  });
}

async function registerMediaProtocol(): Promise<void> {
  protocol.handle("cinesim-media", async (request) => {
    const requestStarted = performance.now();
    let diagnosticAssetId: string | undefined;
    try {
      const url = new URL(request.url);
      const derivedKind = (
        { thumbnail: "thumbnail", filmstrip: "filmstrip", proxy: "proxy" } as const
      )[url.hostname as "thumbnail" | "filmstrip" | "proxy"];
      if (url.hostname !== "asset" && !derivedKind)
        return new Response("Not found", { status: 404 });
      const assetId = url.pathname.slice(1);
      if (!/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(assetId))
        return new Response("Bad asset ID", { status: 400 });
      diagnosticAssetId = assetId;
      const range = request.headers.get("range");
      if (derivedKind) {
        if (url.searchParams.get("v") !== "1")
          return new Response("Unknown generator version", { status: 404 });
        const profileId = url.searchParams.get("profile") ?? undefined;
        if (
          (derivedKind === "proxy" && !profileId) ||
          (profileId !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileId))
        )
          return new Response("Bad proxy profile", { status: 400 });
        const result = await store.derivedMedia.artifactFile(
          derivedKind as DerivedArtifactKind,
          assetId,
          profileId,
        );
        if (request.method === "HEAD")
          return new Response(null, {
            status: 200,
            headers: {
              "Accept-Ranges": "bytes",
              "Access-Control-Allow-Origin": "*",
              "Content-Length": String(result.size),
              "Content-Type": result.mimeType,
              "Cache-Control": "private, max-age=31536000, immutable",
            },
          });
        const match = range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = match ? Number(match[1]) : 0;
        const requestedEnd = match?.[2] ? Number(match[2]) + 1 : result.size;
        return streamedMediaResponse({
          path: result.path,
          size: result.size,
          mimeType: result.mimeType,
          assetId,
          start,
          endExclusive: requestedEnd,
          range: Boolean(range),
          cacheControl: "private, max-age=31536000, immutable",
          requestStarted,
        });
      }
      const path = store.assetPath(assetId);
      if (!path) return new Response("Unknown asset", { status: 404 });
      const fileSize = (await import("node:fs/promises")).stat(path).then((value) => value.size);
      const size = await fileSize;
      if (request.method === "HEAD") {
        store.derivedMedia.recordProtocolRead({
          assetId,
          start: 0,
          requestedEnd: 0,
          bytesRead: 0,
          durationMs: performance.now() - requestStarted,
          range: false,
        });
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
      const requestedEnd = match?.[2] ? Number(match[2]) + 1 : size;
      return streamedMediaResponse({
        path,
        size,
        mimeType: "application/octet-stream",
        assetId,
        start,
        endExclusive: requestedEnd,
        range: Boolean(range),
        cacheControl: "no-store",
        requestStarted,
      });
    } catch (error) {
      store.derivedMedia.recordProtocolError(
        diagnosticAssetId,
        error instanceof Error ? error.message : "Media read failed",
        performance.now() - requestStarted,
      );
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
  ipcMain.handle("derived:get", () => store.derivedMedia.snapshot());
  ipcMain.handle("derived:request-jobs", (_event, assetIds: unknown) => {
    if (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== "string"))
      throw new Error("Invalid derived job request");
    return store.derivedMedia.requestJobs(assetIds);
  });
  ipcMain.handle("derived:write:begin", (_event, input: unknown) =>
    store.derivedMedia.beginWrite(input as BeginDerivedWrite),
  );
  ipcMain.handle(
    "derived:write:chunk",
    (_event, writerId: unknown, offset: unknown, data: unknown) => {
      if (
        typeof writerId !== "string" ||
        typeof offset !== "number" ||
        !(data instanceof Uint8Array)
      )
        throw new Error("Invalid derived write chunk");
      return store.derivedMedia.writeChunk(writerId, offset, data);
    },
  );
  ipcMain.handle("derived:write:finalize", (_event, writerId: unknown, result: unknown) => {
    if (typeof writerId !== "string") throw new Error("Invalid derived writer");
    return store.derivedMedia.finalizeWrite(writerId, result as FinalizeDerivedWrite);
  });
  ipcMain.handle(
    "derived:write:cancel",
    (_event, writerId: unknown, failureCode: unknown, detail: unknown) => {
      if (
        typeof writerId !== "string" ||
        (failureCode !== undefined &&
          (typeof failureCode !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(failureCode))) ||
        (detail !== undefined && (typeof detail !== "string" || detail.length > 2_000))
      )
        throw new Error("Invalid derived writer cancellation");
      return store.derivedMedia.cancelWrite(writerId, failureCode, detail);
    },
  );
  ipcMain.handle("derived:write:progress", (_event, writerId: unknown, progress: unknown) => {
    if (typeof writerId !== "string" || typeof progress !== "number")
      throw new Error("Invalid derived progress");
    return store.derivedMedia.updateProgress(writerId, progress);
  });
  ipcMain.handle("derived:activity", (_event, activity: unknown) =>
    store.derivedMedia.reportActivity(parseDerivedWorkerActivity(activity)),
  );
  ipcMain.handle("derived:performance", (_event, observation: unknown) =>
    store.derivedMedia.reportPerformance(observation as DerivedPerformanceObservation),
  );
  ipcMain.handle("command:execute", (_event, command: EditorCommand) => store.execute(command));
  ipcMain.handle("app-state:get", () => appState.snapshot());
  ipcMain.handle("app-state:set-media-pool-open", async (_event, open: unknown) => {
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing the Media Pool");
    await appState.setMediaPoolOpen(store.directory, open);
    return appState.snapshot();
  });
  ipcMain.handle("app-state:set-inspector-open", async (_event, open: unknown) => {
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing the Inspector");
    await appState.setInspectorOpen(store.directory, open);
    return appState.snapshot();
  });
  ipcMain.handle("app-state:set-notes-open", async (_event, open: unknown) => {
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing Notes");
    await appState.setNotesOpen(store.directory, open);
    return appState.snapshot();
  });
  ipcMain.handle("app-state:set-editor-layout", async (_event, input: unknown) => {
    if (!store.directory) throw new Error("Open a project before changing the editor layout");
    const layout = parseEditorLayoutState(input);
    if (!layout) throw new Error("Invalid editor layout");
    await appState.setEditorLayout(store.directory, layout);
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

async function startApplication(): Promise<void> {
  await app.whenReady();
  appState = new DesktopAppStateStore(join(app.getPath("userData"), "ui-state.json"));
  agentSettings = new AgentSettingsStore(join(app.getPath("userData"), "agent-settings.json"));
  await appState.load();
  await agentSettings.load();
  const diagnosticProject = process.env.CINESIM_DIAGNOSTIC_PROJECT;
  if (
    process.env.CINESIM_DEV_SERVER_URL &&
    diagnosticProject &&
    diagnosticProject.length <= 4_096
  ) {
    await store.open(diagnosticProject);
    log.info(
      { operation: "diagnostic-project-open", projectId: store.project?.id },
      "opened development diagnostic project",
    );
  }
  await registerMediaProtocol();
  store.derivedMedia.subscribe((snapshot) => {
    for (const target of BrowserWindow.getAllWindows())
      target.webContents.send("derived:changed", snapshot);
  });
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
  log.error({ err: error }, "Cinesim failed to start");
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
    .catch((error: unknown) => log.error({ err: error }, "Cinesim agent shutdown failed"))
    .then(() => {
      quitReady = true;
      app.quit();
    });
});

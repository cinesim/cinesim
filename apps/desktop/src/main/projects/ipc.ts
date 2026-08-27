import { lstat, readFile, realpath } from "node:fs/promises";
import { parse, resolve } from "node:path";
import { dialog, ipcMain, shell } from "electron";
import type { EditorCommand } from "@cinesim/core";
import { settingsSchema } from "@cinesim/core";
import type { AgentManager } from "../agents/manager";
import type { DesktopAppStateStore } from "../state/app-state-store";
import type { DesktopProjectStore } from "./project-store";
import { canonicalProjectSizeBytes } from "./project-size";

export function registerProjectIpc(
  store: DesktopProjectStore,
  appState: DesktopAppStateStore,
  agents: AgentManager,
): void {
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
  ipcMain.handle("project:recent-sizes", async () => {
    const projects = appState.snapshot().recentProjects;
    const sizes = await Promise.all(
      projects.map(async (project) => [
        project.directory,
        await canonicalProjectSizeBytes(project.directory).catch(() => null),
      ]),
    );
    return Object.fromEntries(sizes);
  });
  ipcMain.handle("project:save", () => store.save());
  ipcMain.handle("project:settings:update", (_event, update: unknown) => {
    if (!update || typeof update !== "object" || Array.isArray(update))
      throw new Error("Invalid project settings update");
    const current = store.session().settings;
    const next = settingsSchema.parse({ ...current, ...update });
    return store.updateSettings(next);
  });
  ipcMain.handle("project:undo", () => store.undo());
  ipcMain.handle("project:redo", () => store.redo());
  ipcMain.handle("project:reveal", () =>
    store.directory ? shell.openPath(store.directory) : undefined,
  );
  ipcMain.handle("project:forget", async (_event, directory: unknown) => {
    if (
      typeof directory !== "string" ||
      (!appState.hasRecent(directory) && store.directory !== directory)
    )
      throw new Error("Project is not known to Cinesim");
    await appState.forgetProject(directory);
    return appState.snapshot();
  });
  ipcMain.handle("project:trash", async (_event, directory: unknown) => {
    if (
      typeof directory !== "string" ||
      (!appState.hasRecent(directory) && store.directory !== directory)
    )
      throw new Error("Project is not known to Cinesim");
    const requested = resolve(directory);
    if (requested === parse(requested).root) throw new Error("Cannot trash a filesystem root");
    if ((await lstat(requested)).isSymbolicLink())
      throw new Error("Open the project at its real location before moving it to Trash");
    const canonical = await realpath(requested);
    const manifest = JSON.parse(await readFile(resolve(canonical, "cinesim.json"), "utf8")) as {
      version?: unknown;
      id?: unknown;
    };
    if (
      manifest.version !== 1 ||
      typeof manifest.id !== "string" ||
      !manifest.id.startsWith("project_")
    )
      throw new Error("The selected folder is not a recognized Cinesim project");
    await agents.stopProject(directory);
    if (store.directory === directory) await store.close();
    await shell.trashItem(canonical);
    await agents.removeProject(directory);
    await appState.forgetProject(directory);
    return appState.snapshot();
  });
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
}

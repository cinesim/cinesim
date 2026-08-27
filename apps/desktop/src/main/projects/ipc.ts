import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { parse, resolve } from "node:path";
import { dialog, ipcMain, shell } from "electron";
import type { CloudProjectId, EditorCommand, ProjectId } from "@cinesim/core";
import { settingsSchema } from "@cinesim/core";
import type { AgentManager } from "../agents/manager";
import type { DesktopAccountService } from "../account/service";
import type { CloudMediaManager } from "../cloud/manager";
import type { DesktopAppStateStore } from "../state/app-state-store";
import type { DesktopProjectStore } from "./project-store";
import { canonicalProjectSizeBytes } from "./project-size";

export function registerProjectIpc(
  store: DesktopProjectStore,
  appState: DesktopAppStateStore,
  agents: AgentManager,
  account: DesktopAccountService,
  cloudMedia: CloudMediaManager,
): void {
  function activateAccount(): string {
    const userId = account.requireCachedUser().id;
    appState.setAccount(userId);
    return userId;
  }

  async function registeredManifest(directory: string) {
    const manifest = JSON.parse(await readFile(resolve(directory, "cinesim.json"), "utf8")) as {
      version?: unknown;
      id?: unknown;
      cloudProjectId?: unknown;
      name?: unknown;
    };
    if (
      manifest.version !== 1 ||
      typeof manifest.id !== "string" ||
      !/^project_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(manifest.id) ||
      typeof manifest.cloudProjectId !== "string" ||
      !/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(manifest.cloudProjectId) ||
      typeof manifest.name !== "string" ||
      manifest.name.length === 0
    )
      throw new Error("This project is not registered to a Cinesim account");
    return {
      id: manifest.id as ProjectId,
      cloudProjectId: manifest.cloudProjectId as CloudProjectId,
      name: manifest.name,
    };
  }

  async function authorizeOpen(directory: string, allowOffline: boolean): Promise<void> {
    activateAccount();
    const manifest = await registeredManifest(directory);
    try {
      await account.registerProject({
        cloudProjectId: manifest.cloudProjectId,
        clientProjectId: manifest.id,
        name: manifest.name,
      });
    } catch (error) {
      if (!allowOffline) throw error;
    }
  }

  async function reconcileLocalOriginals(): Promise<void> {
    const assetIds =
      store.project?.assets
        .filter((asset) => asset.source.kind === "local" && asset.kind !== "image")
        .map((asset) => asset.id) ?? [];
    if (assetIds.length > 0) await cloudMedia.queue(assetIds);
  }

  ipcMain.handle("project:create", async (_event, name: unknown) => {
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 120)
      throw new Error("Invalid project name");
    const selection = await dialog.showOpenDialog({
      title: "Choose a parent folder for the new Cinesim project",
      buttonLabel: "Create here",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled) return null;
    activateAccount();
    const projectId = `project_${randomUUID().replaceAll("-", "")}` as ProjectId;
    const registration = await account.registerProject({ clientProjectId: projectId, name });
    const session = await store.create(selection.filePaths[0]!, {
      name,
      projectId,
      cloudProjectId: registration.id as CloudProjectId,
    });
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
    activateAccount();
    await authorizeOpen(selection.filePaths[0]!, appState.hasRecent(selection.filePaths[0]!));
    const session = await store.open(selection.filePaths[0]!);
    await appState.rememberProject({ name: session.project.name, directory: session.directory });
    await reconcileLocalOriginals();
    return session;
  });
  ipcMain.handle("project:open-recent", async (_event, directory: unknown) => {
    activateAccount();
    if (typeof directory !== "string" || !appState.hasRecent(directory))
      throw new Error("Project is not in the recent projects list");
    await authorizeOpen(directory, true);
    const session = await store.open(directory);
    await appState.rememberProject({ name: session.project.name, directory: session.directory });
    await reconcileLocalOriginals();
    return session;
  });
  ipcMain.handle("project:session", () =>
    account.cachedUser() && store.project ? store.session() : null,
  );
  ipcMain.handle("project:recent-sizes", async () => {
    activateAccount();
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
    activateAccount();
    if (
      typeof directory !== "string" ||
      (!appState.hasRecent(directory) && store.directory !== directory)
    )
      throw new Error("Project is not known to Cinesim");
    await appState.forgetProject(directory);
    return appState.snapshot();
  });
  ipcMain.handle("project:trash", async (_event, directory: unknown) => {
    activateAccount();
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
    activateAccount();
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
    const importedAssetIds: string[] = [];
    for (const filePath of selection.filePaths) {
      const before = new Set(session.project.assets.map((asset) => asset.id));
      session = await store.inspectAndImportMedia(filePath);
      importedAssetIds.push(
        ...session.project.assets.filter((asset) => !before.has(asset.id)).map((asset) => asset.id),
      );
    }
    if (importedAssetIds.length > 0) await cloudMedia.queue(importedAssetIds);
    return session;
  });
  ipcMain.handle("command:execute", (_event, command: EditorCommand) => store.execute(command));
}

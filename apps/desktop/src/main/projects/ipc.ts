import { dialog, ipcMain, shell } from "electron";
import type { EditorCommand } from "@cinesim/core";
import type { DesktopAppStateStore } from "../state/app-state-store";
import type { DesktopProjectStore } from "./project-store";

export function registerProjectIpc(
  store: DesktopProjectStore,
  appState: DesktopAppStateStore,
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
}

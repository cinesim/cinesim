import { ipcMain } from "electron";
import { parseEditorLayoutState, type DesktopAppStateStore } from "./app-state-store";
import type { DesktopProjectStore } from "../projects/project-store";
import type { DesktopAccountService } from "../account/service";

export function registerAppStateIpc(
  appState: DesktopAppStateStore,
  store: DesktopProjectStore,
  account: DesktopAccountService,
): void {
  function activateAccount(): void {
    appState.setAccount(account.requireCachedUser().id);
  }
  ipcMain.handle("app-state:get", () => {
    activateAccount();
    return appState.snapshot();
  });
  ipcMain.handle("app-state:set-media-pool-open", async (_event, open: unknown) => {
    activateAccount();
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing the Media Pool");
    await appState.setMediaPoolOpen(store.directory, open);
    return appState.snapshot();
  });
  ipcMain.handle("app-state:set-inspector-open", async (_event, open: unknown) => {
    activateAccount();
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing the Inspector");
    await appState.setInspectorOpen(store.directory, open);
    return appState.snapshot();
  });
  ipcMain.handle("app-state:set-notes-open", async (_event, open: unknown) => {
    activateAccount();
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing Notes");
    await appState.setNotesOpen(store.directory, open);
    return appState.snapshot();
  });
  ipcMain.handle("app-state:set-editor-layout", async (_event, input: unknown) => {
    activateAccount();
    if (!store.directory) throw new Error("Open a project before changing the editor layout");
    const layout = parseEditorLayoutState(input);
    if (!layout) throw new Error("Invalid editor layout");
    await appState.setEditorLayout(store.directory, layout);
    return appState.snapshot();
  });
}

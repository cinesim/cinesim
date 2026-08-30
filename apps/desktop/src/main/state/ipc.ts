import type { DesktopAppStateStore } from "./app-state-store";
import type { DesktopProjectStore } from "../projects/project-store";
import { registerIpcHandler } from "../app/secure-ipc";
import { appContracts } from "../app/contracts";

export function registerAppStateIpc(
  appState: DesktopAppStateStore,
  store: DesktopProjectStore,
): void {
  registerIpcHandler(appContracts.stateGet, () => appState.snapshot());
  registerIpcHandler(appContracts.setMediaPoolOpen, async ({ open }) => {
    if (!store.directory) throw new Error("Open a project before changing the Media Pool");
    await appState.setMediaPoolOpen(store.directory, open);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setInspectorOpen, async ({ open }) => {
    if (!store.directory) throw new Error("Open a project before changing the Inspector");
    await appState.setInspectorOpen(store.directory, open);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setNotesOpen, async ({ open }) => {
    if (!store.directory) throw new Error("Open a project before changing Notes");
    await appState.setNotesOpen(store.directory, open);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setEditorLayout, async ({ layout }) => {
    if (!store.directory) throw new Error("Open a project before changing the editor layout");
    await appState.setEditorLayout(store.directory, layout);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setCutLayout, async ({ layout }) => {
    if (!store.directory) throw new Error("Open a project before changing the Cut layout");
    await appState.setCutLayout(store.directory, layout);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setTranscriptionSettings, async ({ settings }) => {
    await appState.setTranscriptionSettings(settings);
    return appState.snapshot();
  });
}

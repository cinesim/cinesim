import type { DesktopAppStateStore } from "./app-state-store";
import type { DesktopProjectStore } from "../projects/project-store";
import { registerIpcHandler } from "../app/secure-ipc";
import { appContracts } from "../app/contracts";

function openProjectDirectory(store: DesktopProjectStore, action: string): string {
  if (!store.directory) throw new Error(`Open a project before ${action}`);
  return store.directory;
}

export function registerAppStateIpc(
  appState: DesktopAppStateStore,
  store: DesktopProjectStore,
): void {
  registerIpcHandler(appContracts.stateGet, () => appState.snapshot());
  registerIpcHandler(appContracts.setMediaPoolOpen, async ({ open }) => {
    await appState.setMediaPoolOpen(openProjectDirectory(store, "changing the Media Pool"), open);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setInspectorOpen, async ({ open }) => {
    await appState.setInspectorOpen(openProjectDirectory(store, "changing the Inspector"), open);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setNotesOpen, async ({ open }) => {
    await appState.setNotesOpen(openProjectDirectory(store, "changing Notes"), open);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setEditorLayout, async ({ layout }) => {
    await appState.setEditorLayout(
      openProjectDirectory(store, "changing the editor layout"),
      layout,
    );
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setCutLayout, async ({ layout }) => {
    await appState.setCutLayout(openProjectDirectory(store, "changing the Cut layout"), layout);
    return appState.snapshot();
  });
  registerIpcHandler(appContracts.setTranscriptionSettings, async ({ settings }) => {
    await appState.setTranscriptionSettings(settings);
    return appState.snapshot();
  });
}

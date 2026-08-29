import {
  parseCutLayoutState,
  parseEditorLayoutState,
  parseTranscriptionSettings,
  type DesktopAppStateStore,
} from "./app-state-store";
import type { DesktopProjectStore } from "../projects/project-store";
import { registerIpcHandler } from "../app/secure-ipc";

export function registerAppStateIpc(
  appState: DesktopAppStateStore,
  store: DesktopProjectStore,
): void {
  registerIpcHandler("app-state:get", () => appState.snapshot());
  registerIpcHandler("app-state:set-media-pool-open", async (open: unknown) => {
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing the Media Pool");
    await appState.setMediaPoolOpen(store.directory, open);
    return appState.snapshot();
  });
  registerIpcHandler("app-state:set-inspector-open", async (open: unknown) => {
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing the Inspector");
    await appState.setInspectorOpen(store.directory, open);
    return appState.snapshot();
  });
  registerIpcHandler("app-state:set-notes-open", async (open: unknown) => {
    if (!store.directory || typeof open !== "boolean")
      throw new Error("Open a project before changing Notes");
    await appState.setNotesOpen(store.directory, open);
    return appState.snapshot();
  });
  registerIpcHandler("app-state:set-editor-layout", async (input: unknown) => {
    if (!store.directory) throw new Error("Open a project before changing the editor layout");
    const layout = parseEditorLayoutState(input);
    if (!layout) throw new Error("Invalid editor layout");
    await appState.setEditorLayout(store.directory, layout);
    return appState.snapshot();
  });
  registerIpcHandler("app-state:set-cut-layout", async (input: unknown) => {
    if (!store.directory) throw new Error("Open a project before changing the Cut layout");
    const layout = parseCutLayoutState(input);
    if (!layout) throw new Error("Invalid Cut layout");
    await appState.setCutLayout(store.directory, layout);
    return appState.snapshot();
  });
  registerIpcHandler("app-state:set-transcription-settings", async (input: unknown) => {
    const settings = parseTranscriptionSettings(input);
    if (!settings) throw new Error("Invalid transcription settings");
    await appState.setTranscriptionSettings(settings);
    return appState.snapshot();
  });
}

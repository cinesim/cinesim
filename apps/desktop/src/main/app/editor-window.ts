import { join } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import type { DevelopmentConfiguration } from "./development-configuration";
import { editorWebPreferences, installEditorNavigationPolicy } from "./editor-security";
import { trustIpcRenderer } from "./secure-ipc";
import { CINESIM_RENDERER_ENTRY_URL } from "./protocols";

export function createEditorWindow(configuration: DevelopmentConfiguration): BrowserWindow {
  const window = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#f9f9f9",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: editorWebPreferences(join(app.getAppPath(), "dist/preload/preload.cjs")),
  });
  trustIpcRenderer(window.webContents);
  window.once("ready-to-show", () => window.show());
  installEditorNavigationPolicy(window.webContents);
  if (configuration.rendererUrl) void window.loadURL(configuration.rendererUrl.href);
  else void window.loadURL(CINESIM_RENDERER_ENTRY_URL);
  return window;
}

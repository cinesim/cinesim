import type { WebContents, WebPreferences } from "electron";
import { EDITOR_SESSION_PARTITION } from "./protocols";

export function editorWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    partition: EDITOR_SESSION_PARTITION,
  };
}

export function installEditorNavigationPolicy(webContents: WebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event) => event.preventDefault());
}

export function denyPermissionCheck(): false {
  return false;
}

export function denyPermissionRequest(
  _webContents: WebContents,
  _permission: string,
  callback: (permissionGranted: boolean) => void,
): void {
  callback(false);
}

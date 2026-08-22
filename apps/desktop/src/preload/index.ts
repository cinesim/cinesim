import { contextBridge, ipcRenderer } from "electron";
import type { EditorCommand } from "@cinesim/core";
import type { DesktopApi } from "../shared/api";

const api: DesktopApi = {
  createProject: (name) => ipcRenderer.invoke("project:create", name),
  openProject: () => ipcRenderer.invoke("project:open"),
  openRecentProject: (directory) => ipcRenderer.invoke("project:open-recent", directory),
  importMedia: () => ipcRenderer.invoke("media:import"),
  execute: (command: EditorCommand) => ipcRenderer.invoke("command:execute", command),
  undo: () => ipcRenderer.invoke("project:undo"),
  redo: () => ipcRenderer.invoke("project:redo"),
  save: () => ipcRenderer.invoke("project:save"),
  revealProject: () => ipcRenderer.invoke("project:reveal"),
  getSession: () => ipcRenderer.invoke("project:session"),
  getAppState: () => ipcRenderer.invoke("app-state:get"),
  setProjectView: (view) => ipcRenderer.invoke("app-state:set-project-view", view),
  onCloseActiveTab: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:close-active-tab", listener);
    return () => ipcRenderer.removeListener("app:close-active-tab", listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("cinesim", api);

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
  getAgentSettings: () => ipcRenderer.invoke("agents:settings:get"),
  updateAgentSettings: (update) => ipcRenderer.invoke("agents:settings:update", update),
  refreshAgentProviders: () => ipcRenderer.invoke("agents:providers:refresh"),
  chooseAgentExecutable: (provider) => ipcRenderer.invoke("agents:executable:choose", provider),
  openAgentLogin: (provider) => ipcRenderer.invoke("agents:login", provider),
  getAgents: (projectDirectory) => ipcRenderer.invoke("agents:get", projectDirectory),
  createAgent: (input) => ipcRenderer.invoke("agents:create", input),
  selectAgent: (projectDirectory, sessionId) =>
    ipcRenderer.invoke("agents:select", projectDirectory, sessionId),
  deleteAgent: (projectDirectory, sessionId) =>
    ipcRenderer.invoke("agents:delete", projectDirectory, sessionId),
  sendAgentMessage: (sessionId, message, context) =>
    ipcRenderer.invoke("agents:send", sessionId, message, context),
  interruptAgent: (sessionId) => ipcRenderer.invoke("agents:interrupt", sessionId),
  respondAgentApproval: (sessionId, requestId, decision) =>
    ipcRenderer.invoke("agents:approval", sessionId, requestId, decision),
  revertAgentTurn: (sessionId, turnId) => ipcRenderer.invoke("agents:revert", sessionId, turnId),
  onAgentsChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: Parameters<typeof callback>[0],
    ) => callback(snapshot);
    ipcRenderer.on("agents:changed", listener);
    return () => ipcRenderer.removeListener("agents:changed", listener);
  },
  onProjectChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, session: Parameters<typeof callback>[0]) =>
      callback(session);
    ipcRenderer.on("project:changed", listener);
    return () => ipcRenderer.removeListener("project:changed", listener);
  },
  onCloseActiveTab: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:close-active-tab", listener);
    return () => ipcRenderer.removeListener("app:close-active-tab", listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("cinesim", api);

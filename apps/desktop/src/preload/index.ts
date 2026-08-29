import { contextBridge, ipcRenderer } from "electron";
import type { EditorCommand } from "@cinesim/core";
import type { DesktopApi } from "../shared/api";

const api: DesktopApi = {
  getAccountSnapshot: () => ipcRenderer.invoke("account:get"),
  beginAccountSignIn: (method) => ipcRenderer.invoke("account:sign-in", method),
  signOutAccount: () => ipcRenderer.invoke("account:sign-out"),
  getCloudStorageUsage: () => ipcRenderer.invoke("cloud:usage"),
  configureCloudStorageAddon: (addonBytes) =>
    ipcRenderer.invoke("cloud:configure-addon", addonBytes),
  getCloudTransfers: () => ipcRenderer.invoke("cloud:transfers"),
  retryCloudTransfer: (assetId) => ipcRenderer.invoke("cloud:retry", assetId),
  cancelCloudTransfer: (assetId) => ipcRenderer.invoke("cloud:cancel", assetId),
  getDownloadedCloudOriginals: () => ipcRenderer.invoke("cloud:downloaded-originals"),
  keepCloudOriginalDownloaded: (assetId) => ipcRenderer.invoke("cloud:keep-downloaded", assetId),
  removeCloudOriginalDownload: (assetId) => ipcRenderer.invoke("cloud:remove-download", assetId),
  trashCloudAssets: (cloudAssetIds) => ipcRenderer.invoke("cloud:trash-assets", cloudAssetIds),
  restoreCloudAsset: (cloudAssetId) => ipcRenderer.invoke("cloud:restore-asset", cloudAssetId),
  deleteCloudAsset: (cloudAssetId) => ipcRenderer.invoke("cloud:delete-asset", cloudAssetId),
  createProject: (name, kind) => ipcRenderer.invoke("project:create", name, kind),
  openProject: () => ipcRenderer.invoke("project:open"),
  openRecentProject: (directory) => ipcRenderer.invoke("project:open-recent", directory),
  importMedia: () => ipcRenderer.invoke("media:import"),
  getDerivedMediaSnapshot: (scope) => ipcRenderer.invoke("derived:get", scope),
  requestDerivedJobs: (scope, assetIds) =>
    ipcRenderer.invoke("derived:request-jobs", scope, assetIds),
  requestProxyJobs: (scope, assetIds) =>
    ipcRenderer.invoke("derived:request-proxies", scope, assetIds),
  getTranscriptSnapshot: (scope, assetIds) =>
    ipcRenderer.invoke("transcripts:get", scope, assetIds),
  requestTranscriptJobs: (scope, assetIds) =>
    ipcRenderer.invoke("transcripts:request", scope, assetIds),
  beginTranscriptJob: (scope, assetId) => ipcRenderer.invoke("transcripts:begin", scope, assetId),
  transcribeAudioChunk: (scope, input) => ipcRenderer.invoke("transcripts:chunk", scope, input),
  finalizeTranscriptJob: (scope, jobId) => ipcRenderer.invoke("transcripts:finalize", scope, jobId),
  failTranscriptJob: (scope, jobId, failureCode, detail) =>
    ipcRenderer.invoke("transcripts:fail", scope, jobId, failureCode, detail),
  beginDerivedWrite: (scope, input) => ipcRenderer.invoke("derived:write:begin", scope, input),
  writeDerivedChunk: (writerId, offset, data) =>
    ipcRenderer.invoke("derived:write:chunk", writerId, offset, data),
  finalizeDerivedWrite: (writerId, result) =>
    ipcRenderer.invoke("derived:write:finalize", writerId, result),
  cancelDerivedWrite: (writerId, failureCode, detail) =>
    ipcRenderer.invoke("derived:write:cancel", writerId, failureCode, detail),
  updateDerivedProgress: (writerId, progress) =>
    ipcRenderer.invoke("derived:write:progress", writerId, progress),
  reportDerivedActivity: (scope, activity) =>
    ipcRenderer.invoke("derived:activity", scope, activity),
  reportDerivedPerformance: (scope, observation) =>
    ipcRenderer.invoke("derived:performance", scope, observation),
  execute: (command: EditorCommand) => ipcRenderer.invoke("command:execute", command),
  undo: () => ipcRenderer.invoke("project:undo"),
  redo: () => ipcRenderer.invoke("project:redo"),
  save: () => ipcRenderer.invoke("project:save"),
  updateProjectSettings: (update) => ipcRenderer.invoke("project:settings:update", update),
  revealProject: () => ipcRenderer.invoke("project:reveal"),
  forgetProject: (directory) => ipcRenderer.invoke("project:forget", directory),
  trashProject: (directory) => ipcRenderer.invoke("project:trash", directory),
  getSession: () => ipcRenderer.invoke("project:session"),
  getRecentProjectSizes: () => ipcRenderer.invoke("project:recent-sizes"),
  getAppState: () => ipcRenderer.invoke("app-state:get"),
  getElectronHealthSnapshot: () => ipcRenderer.invoke("app:health"),
  setProjectMediaPoolOpen: (open) => ipcRenderer.invoke("app-state:set-media-pool-open", open),
  setProjectInspectorOpen: (open) => ipcRenderer.invoke("app-state:set-inspector-open", open),
  setProjectNotesOpen: (open) => ipcRenderer.invoke("app-state:set-notes-open", open),
  setProjectEditorLayout: (layout) => ipcRenderer.invoke("app-state:set-editor-layout", layout),
  getAgentSettings: () => ipcRenderer.invoke("agents:settings:get"),
  updateAgentSettings: (update) => ipcRenderer.invoke("agents:settings:update", update),
  refreshAgentProviders: () => ipcRenderer.invoke("agents:providers:refresh"),
  chooseAgentExecutable: (provider) => ipcRenderer.invoke("agents:executable:choose", provider),
  openAgentLogin: (provider) => ipcRenderer.invoke("agents:login", provider),
  getAgents: (projectDirectory) => ipcRenderer.invoke("agents:get", projectDirectory),
  ensureAgent: (input) => ipcRenderer.invoke("agents:ensure", input),
  createAgent: (input) => ipcRenderer.invoke("agents:create", input),
  updateAgent: (sessionId, update) => ipcRenderer.invoke("agents:update", sessionId, update),
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
  onDerivedMediaChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: Parameters<typeof callback>[0],
    ) => callback(snapshot);
    ipcRenderer.on("derived:changed", listener);
    return () => ipcRenderer.removeListener("derived:changed", listener);
  },
  onTranscriptsChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: Parameters<typeof callback>[0],
    ) => callback(snapshot);
    ipcRenderer.on("transcripts:changed", listener);
    return () => ipcRenderer.removeListener("transcripts:changed", listener);
  },
  onAccountChanged: (callback) => {
    const refreshSnapshot = async () => {
      try {
        const snapshot = await ipcRenderer.invoke("account:get");
        callback(snapshot);
      } catch {
        // The renderer keeps its last safe snapshot if the main process is shutting down.
      }
    };
    const refresh = () => {
      void refreshSnapshot();
    };
    ipcRenderer.on("account:changed", refresh);
    ipcRenderer.on("cinesim-auth:authenticated", refresh);
    ipcRenderer.on("cinesim-auth:user-updated", refresh);
    ipcRenderer.on("cinesim-auth:error", refresh);
    return () => {
      ipcRenderer.removeListener("account:changed", refresh);
      ipcRenderer.removeListener("cinesim-auth:authenticated", refresh);
      ipcRenderer.removeListener("cinesim-auth:user-updated", refresh);
      ipcRenderer.removeListener("cinesim-auth:error", refresh);
    };
  },
  onCloudTransfersChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: Parameters<typeof callback>[0],
    ) => callback(snapshot);
    ipcRenderer.on("cloud:transfers-changed", listener);
    return () => ipcRenderer.removeListener("cloud:transfers-changed", listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("cinesim", api);

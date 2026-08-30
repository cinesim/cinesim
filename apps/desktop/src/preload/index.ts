import { contextBridge, ipcRenderer } from "electron";
import type { AccountSnapshot, DesktopApi } from "../shared/contracts";
import { eventChannels, invokeChannels } from "../shared/contracts/channels";
import type { DesktopIpcResult } from "../shared/contracts/ipc";
import { unwrapDesktopIpcResult } from "../shared/contracts/ipc";

async function invoke<TResult>(channel: string, ...arguments_: unknown[]): Promise<TResult> {
  const result = (await ipcRenderer.invoke(channel, ...arguments_)) as DesktopIpcResult<TResult>;
  return unwrapDesktopIpcResult(result);
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: DesktopApi = {
  account: {
    get: () => invoke(invokeChannels.account.get),
    beginSignIn: (method) => invoke(invokeChannels.account.signIn, { method }),
    signOut: () => invoke(invokeChannels.account.signOut),
    onChanged: (callback) => {
      const refreshSnapshot = async () => {
        try {
          callback(await invoke<AccountSnapshot>(invokeChannels.account.get));
        } catch {
          // The renderer keeps its last safe snapshot if the main process is shutting down.
        }
      };
      const refresh = () => void refreshSnapshot();
      const channels = [
        eventChannels.accountChanged,
        eventChannels.authAuthenticated,
        eventChannels.authUserUpdated,
        eventChannels.authError,
      ];
      for (const channel of channels) ipcRenderer.on(channel, refresh);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        for (const channel of channels) ipcRenderer.removeListener(channel, refresh);
      };
    },
  },
  cloud: {
    getUsage: () => invoke(invokeChannels.cloud.usage),
    configureAddon: (addonBytes) => invoke(invokeChannels.cloud.configureAddon, { addonBytes }),
    getTransfers: () => invoke(invokeChannels.cloud.transfers),
    retryTransfer: (assetId) => invoke(invokeChannels.cloud.retry, { assetId }),
    cancelTransfer: (assetId) => invoke(invokeChannels.cloud.cancel, { assetId }),
    getDownloadedOriginals: () => invoke(invokeChannels.cloud.downloadedOriginals),
    keepOriginalDownloaded: (assetId) => invoke(invokeChannels.cloud.keepDownloaded, { assetId }),
    removeOriginalDownload: (assetId) => invoke(invokeChannels.cloud.removeDownload, { assetId }),
    trashAssets: (cloudAssetIds) => invoke(invokeChannels.cloud.trashAssets, { cloudAssetIds }),
    restoreAsset: (cloudAssetId) => invoke(invokeChannels.cloud.restoreAsset, { cloudAssetId }),
    deleteAsset: (cloudAssetId) => invoke(invokeChannels.cloud.deleteAsset, { cloudAssetId }),
    onTransfersChanged: (callback) => subscribe(eventChannels.cloudTransfersChanged, callback),
  },
  project: {
    create: (name, kind) => invoke(invokeChannels.project.create, { name, kind }),
    open: () => invoke(invokeChannels.project.open),
    openRecent: (directory) => invoke(invokeChannels.project.openRecent, { directory }),
    importMedia: () => invoke(invokeChannels.project.importMedia),
    execute: (command) => invoke(invokeChannels.project.execute, { command }),
    undo: () => invoke(invokeChannels.project.undo),
    redo: () => invoke(invokeChannels.project.redo),
    save: () => invoke(invokeChannels.project.save),
    updateSettings: (update) => invoke(invokeChannels.project.settingsUpdate, { update }),
    reveal: () => invoke(invokeChannels.project.reveal),
    forget: (directory) => invoke(invokeChannels.project.forget, { directory }),
    trash: (directory) => invoke(invokeChannels.project.trash, { directory }),
    getSession: () => invoke(invokeChannels.project.session),
    getRecentSizes: () => invoke(invokeChannels.project.recentSizes),
    onChanged: (callback) => subscribe(eventChannels.projectChanged, callback),
  },
  derived: {
    get: (scope) => invoke(invokeChannels.derived.get, { scope }),
    requestJobs: (scope, assetIds) =>
      invoke(invokeChannels.derived.requestJobs, { scope, assetIds }),
    requestProxies: (scope, assetIds) =>
      invoke(invokeChannels.derived.requestProxies, { scope, assetIds }),
    beginWrite: (scope, input) => invoke(invokeChannels.derived.writeBegin, { scope, input }),
    writeChunk: (writerId, offset, data) =>
      invoke(invokeChannels.derived.writeChunk, { writerId, offset, data }),
    finalizeWrite: (writerId, result) =>
      invoke(invokeChannels.derived.writeFinalize, { writerId, result }),
    cancelWrite: (writerId, failureCode, detail) =>
      invoke(invokeChannels.derived.writeCancel, { writerId, failureCode, detail }),
    updateProgress: (writerId, progress) =>
      invoke(invokeChannels.derived.writeProgress, { writerId, progress }),
    reportActivity: (scope, activity) =>
      invoke(invokeChannels.derived.activity, { scope, activity }),
    reportPerformance: (scope, observation) =>
      invoke(invokeChannels.derived.performance, { scope, observation }),
    onChanged: (callback) => subscribe(eventChannels.derivedChanged, callback),
  },
  transcripts: {
    get: (scope, assetIds) => invoke(invokeChannels.transcripts.get, { scope, assetIds }),
    requestJobs: (scope, assetIds) =>
      invoke(invokeChannels.transcripts.request, { scope, assetIds }),
    cancelJobs: (scope, assetIds) => invoke(invokeChannels.transcripts.cancel, { scope, assetIds }),
    beginJob: (scope, assetId) => invoke(invokeChannels.transcripts.begin, { scope, assetId }),
    transcribeChunk: (scope, input) => invoke(invokeChannels.transcripts.chunk, { scope, input }),
    finalizeJob: (scope, jobId) => invoke(invokeChannels.transcripts.finalize, { scope, jobId }),
    failJob: (scope, jobId, failureCode, detail) =>
      invoke(invokeChannels.transcripts.fail, { scope, jobId, failureCode, detail }),
    onChanged: (callback) => subscribe(eventChannels.transcriptsChanged, callback),
  },
  appState: {
    get: () => invoke(invokeChannels.appState.get),
    setMediaPoolOpen: (open) => invoke(invokeChannels.appState.setMediaPoolOpen, { open }),
    setInspectorOpen: (open) => invoke(invokeChannels.appState.setInspectorOpen, { open }),
    setNotesOpen: (open) => invoke(invokeChannels.appState.setNotesOpen, { open }),
    setEditorLayout: (layout) => invoke(invokeChannels.appState.setEditorLayout, { layout }),
    setCutLayout: (layout) => invoke(invokeChannels.appState.setCutLayout, { layout }),
    setTranscriptionSettings: (settings) =>
      invoke(invokeChannels.appState.setTranscriptionSettings, { settings }),
  },
  agents: {
    getSettings: () => invoke(invokeChannels.agents.settingsGet),
    updateSettings: (update) => invoke(invokeChannels.agents.settingsUpdate, { update }),
    refreshProviders: () => invoke(invokeChannels.agents.providersRefresh),
    chooseExecutable: (provider) => invoke(invokeChannels.agents.executableChoose, { provider }),
    openLogin: (provider) => invoke(invokeChannels.agents.login, { provider }),
    get: (projectDirectory) => invoke(invokeChannels.agents.get, { projectDirectory }),
    ensure: (input) => invoke(invokeChannels.agents.ensure, { input }),
    create: (input) => invoke(invokeChannels.agents.create, { input }),
    update: (sessionId, update) => invoke(invokeChannels.agents.update, { sessionId, update }),
    select: (projectDirectory, sessionId) =>
      invoke(invokeChannels.agents.select, { projectDirectory, sessionId }),
    delete: (projectDirectory, sessionId) =>
      invoke(invokeChannels.agents.delete, { projectDirectory, sessionId }),
    send: (sessionId, message, context) =>
      invoke(invokeChannels.agents.send, { sessionId, message, context }),
    interrupt: (sessionId) => invoke(invokeChannels.agents.interrupt, { sessionId }),
    respondApproval: (sessionId, requestId, decision) =>
      invoke(invokeChannels.agents.approval, { sessionId, requestId, decision }),
    revertTurn: (sessionId, turnId) => invoke(invokeChannels.agents.revert, { sessionId, turnId }),
    onChanged: (callback) => subscribe(eventChannels.agentsChanged, callback),
  },
  health: { get: () => invoke(invokeChannels.app.health) },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("cinesim", api);

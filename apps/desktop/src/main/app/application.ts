import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createCinesimLogger } from "@cinesim/logging";
import { registerAgentIpc } from "../agents/ipc";
import { AgentManager } from "../agents/manager";
import { AgentSettingsStore } from "../agents/settings-store";
import { registerDerivedMediaIpc } from "../derived-media/ipc";
import { registerMediaProtocol } from "../derived-media/media-protocol";
import { registerProjectIpc } from "../projects/ipc";
import { DesktopProjectStore } from "../projects/project-store";
import { DesktopAppStateStore } from "../state/app-state-store";
import { registerAppStateIpc } from "../state/ipc";
import { createEditorWindow } from "./editor-window";
import { MainEventLoopMonitor } from "./event-loop-monitor";
import { registerAppIpc } from "./ipc";
import type { ApplicationLifecycle } from "./lifecycle";

const log = createCinesimLogger({ service: "desktop" });

export class DesktopApplication implements ApplicationLifecycle {
  readonly projectStore = new DesktopProjectStore();
  #agents: AgentManager | null = null;
  #eventLoopMonitor = new MainEventLoopMonitor();

  async start(): Promise<void> {
    await app.whenReady();
    this.#eventLoopMonitor.start();

    const appState = new DesktopAppStateStore(join(app.getPath("userData"), "ui-state.json"));
    const agentSettings = new AgentSettingsStore(
      join(app.getPath("userData"), "agent-settings.json"),
    );
    await Promise.all([appState.load(), agentSettings.load()]);

    const diagnosticProject = process.env.CINESIM_DIAGNOSTIC_PROJECT;
    if (
      process.env.CINESIM_DEV_SERVER_URL &&
      diagnosticProject &&
      diagnosticProject.length <= 4_096
    ) {
      await this.projectStore.open(diagnosticProject);
      log.info(
        { operation: "diagnostic-project-open", projectId: this.projectStore.project?.id },
        "opened development diagnostic project",
      );
    }

    await registerMediaProtocol(this.projectStore);
    this.projectStore.derivedMedia.subscribe((snapshot) => {
      for (const target of BrowserWindow.getAllWindows())
        target.webContents.send("derived:changed", snapshot);
    });

    const agents = new AgentManager(
      join(app.getPath("userData"), "agent-sessions.json"),
      agentSettings,
      this.projectStore,
      (snapshot) => {
        for (const target of BrowserWindow.getAllWindows())
          target.webContents.send("agents:changed", snapshot);
      },
      () => {
        if (!this.projectStore.project) return;
        const session = this.projectStore.session();
        for (const target of BrowserWindow.getAllWindows())
          target.webContents.send("project:changed", session);
      },
    );
    this.#agents = agents;
    await agents.load();

    registerProjectIpc(this.projectStore, appState, agents);
    registerDerivedMediaIpc(this.projectStore.derivedMedia);
    registerAppStateIpc(appState, this.projectStore);
    registerAgentIpc(agents, agentSettings);
    registerAppIpc(log, this.#eventLoopMonitor);

    this.#openWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) this.#openWindow();
    });
  }

  async close(): Promise<void> {
    this.#eventLoopMonitor.stop();
    await this.#agents
      ?.close()
      .catch((error: unknown) => log.error({ err: error }, "Cinesim agent shutdown failed"));
    if (this.projectStore.project)
      await this.projectStore
        .close()
        .catch((error: unknown) => log.error({ err: error }, "Project shutdown failed"));
  }

  #openWindow(): void {
    const window = createEditorWindow();
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
  }
}

export function reportApplicationStartFailure(error: unknown): void {
  log.error({ err: error }, "Cinesim failed to start");
}

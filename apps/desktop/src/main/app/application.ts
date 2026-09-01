import { join } from "node:path";
import { app } from "electron";
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
import { registerAccountIpc } from "../account/ipc";
import type { DesktopAccountService } from "../account/service";
import { registerCloudIpc } from "../cloud/ipc";
import { CloudMediaManager } from "../cloud/manager";
import { registerTranscriptIpc } from "../transcripts/ipc";
import { registerVisualIndexIpc } from "../visual-index/ipc";
import { registerFrameIpc } from "../frames/ipc";
import type { DevelopmentConfiguration } from "./development-configuration";
import { configureIpcSecurity } from "./secure-ipc";
import { desktopEvents } from "../../shared/contracts/events";
import { editorSession } from "./protocols";
import { registerRendererProtocol } from "./renderer-protocol";
import { denyPermissionCheck, denyPermissionRequest } from "./editor-security";
import type { EditorWindowRegistry } from "./editor-window-registry";

const log = createCinesimLogger({ service: "desktop" });

export class DesktopApplication implements ApplicationLifecycle {
  readonly projectStore: DesktopProjectStore;
  #agents: AgentManager | null = null;
  #eventLoopMonitor = new MainEventLoopMonitor();

  constructor(
    private readonly accountService: DesktopAccountService,
    private readonly development: DevelopmentConfiguration,
    private readonly windows: EditorWindowRegistry,
  ) {
    this.projectStore = new DesktopProjectStore(
      accountService,
      () => this.windows.broadcast(desktopEvents.visualIndexChanged),
      (request) => {
        if (this.windows.size === 0) return false;
        this.windows.sendPrimary(desktopEvents.frameRequested, request);
        return true;
      },
      (requestId) => this.windows.sendPrimary(desktopEvents.frameCanceled, { requestId }),
    );
    configureIpcSecurity({ developmentUrl: development.rendererUrl });
  }

  async start(): Promise<void> {
    await app.whenReady();
    this.#eventLoopMonitor.start();
    this.#configureEditorSession();

    const { appState, agentSettings } = await this.#loadLocalState();
    this.projectStore.setDefaultAgentInstructions(
      () => agentSettings.snapshot().projectInstructions,
    );
    const cloudMedia = await this.#createCloudMedia(appState);
    await this.#openDiagnosticProject();
    await this.#registerMedia(cloudMedia);
    const agents = await this.#createAgents(agentSettings);
    this.#registerIpc(appState, agentSettings, cloudMedia, agents);

    this.#openWindow();
    app.on("activate", () => {
      if (this.windows.size === 0) this.#openWindow();
    });
  }

  #configureEditorSession(): void {
    const secureEditorSession = editorSession();
    secureEditorSession.setPermissionCheckHandler(denyPermissionCheck);
    secureEditorSession.setPermissionRequestHandler(denyPermissionRequest);
    registerRendererProtocol();
  }

  async #loadLocalState(): Promise<{
    appState: DesktopAppStateStore;
    agentSettings: AgentSettingsStore;
  }> {
    const appState = new DesktopAppStateStore(join(app.getPath("userData"), "ui-state.json"));
    const agentSettings = new AgentSettingsStore(
      join(app.getPath("userData"), "agent-settings.json"),
    );
    await Promise.all([appState.load(), agentSettings.load()]);
    appState.setAccount(this.accountService.cachedUser()?.id ?? null);
    return { appState, agentSettings };
  }

  async #createCloudMedia(appState: DesktopAppStateStore): Promise<CloudMediaManager> {
    const cloudMedia = new CloudMediaManager(
      join(app.getPath("userData"), "cloud-transfers.json"),
      this.accountService,
      this.projectStore,
      {
        transfersChanged: (snapshot) => {
          this.windows.broadcast(desktopEvents.cloudTransfersChanged, snapshot);
        },
        projectChanged: (session) => {
          this.windows.broadcast(desktopEvents.projectChanged, session);
        },
      },
    );
    await cloudMedia.load();
    const unsubscribeAccount = this.accountService.subscribe((snapshot) => {
      appState.setAccount(snapshot.user?.id ?? null);
      if (snapshot.status === "signed-in" && snapshot.cloudStorage === true)
        void cloudMedia.resumeAvailable();
    });
    app.once("will-quit", unsubscribeAccount);
    return cloudMedia;
  }

  async #openDiagnosticProject(): Promise<void> {
    const diagnosticProject = this.development.diagnosticProject;
    if (!diagnosticProject) return;
    await this.projectStore.open(diagnosticProject);
    log.info(
      { operation: "diagnostic-project-open", projectId: this.projectStore.project?.id },
      "opened development diagnostic project",
    );
  }

  async #registerMedia(cloudMedia: CloudMediaManager): Promise<void> {
    await registerMediaProtocol(this.projectStore, cloudMedia, this.development.rendererUrl);
    const unsubscribeProject = this.projectStore.subscribe((session) => {
      this.windows.broadcast(desktopEvents.projectChanged, session);
    });
    app.once("will-quit", unsubscribeProject);
    this.projectStore.derivedMedia.subscribe((snapshot) => {
      this.windows.broadcast(desktopEvents.derivedChanged, snapshot);
    });
    this.projectStore.transcripts.subscribe((snapshot) => {
      this.windows.broadcast(desktopEvents.transcriptsChanged, snapshot);
    });
  }

  async #createAgents(agentSettings: AgentSettingsStore): Promise<AgentManager> {
    const agents = new AgentManager(
      join(app.getPath("userData"), "agent-sessions.json"),
      agentSettings,
      this.projectStore,
      (delta) => {
        this.windows.broadcast(desktopEvents.agentsDelta, delta);
      },
      () => {
        if (!this.projectStore.project) return;
        const session = this.projectStore.session();
        this.windows.broadcast(desktopEvents.projectChanged, session);
      },
    );
    this.#agents = agents;
    await agents.load();
    return agents;
  }

  #registerIpc(
    appState: DesktopAppStateStore,
    agentSettings: AgentSettingsStore,
    cloudMedia: CloudMediaManager,
    agents: AgentManager,
  ): void {
    registerProjectIpc(this.projectStore, appState, agents, this.accountService, cloudMedia);
    registerDerivedMediaIpc(this.projectStore.derivedMedia);
    registerFrameIpc(this.projectStore.frames);
    registerTranscriptIpc(this.projectStore.transcripts);
    registerVisualIndexIpc(this.projectStore);
    registerAppStateIpc(appState, this.projectStore);
    registerAgentIpc(agents, agentSettings);
    registerAppIpc(log, this.#eventLoopMonitor);
    registerAccountIpc(this.accountService, this.windows, async () => {
      appState.setAccount(null);
      if (this.projectStore.project?.cloudProjectId) {
        if (this.projectStore.directory) await agents.stopProject(this.projectStore.directory);
        await this.projectStore.close();
      }
    });
    registerCloudIpc(cloudMedia);
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
    this.windows.register(createEditorWindow(this.development));
  }
}

export function reportApplicationStartFailure(error: unknown): void {
  log.error({ err: error }, "Cinesim failed to start");
}

import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { parse, resolve } from "node:path";
import { dialog, shell } from "electron";
import { cloudProjectIdSchema, projectIdSchema, settingsSchema } from "@cinesim/core";
import type { ProjectId } from "@cinesim/core";
import { parseProjectManifest } from "@cinesim/project-io";
import type { CreateProjectLocation, RecentProjectDetails } from "../../shared/contracts";
import type { AgentManager } from "../agents/manager";
import type { DesktopAccountService } from "../account/service";
import type { CloudMediaManager } from "../cloud/manager";
import type { DesktopAppStateStore } from "../state/app-state-store";
import { requireUserIntent } from "../app/user-intent";
import { canonicalProjectSizeBytes } from "./project-size";
import { isTemporaryMediaSelection } from "./media-import";
import type { DesktopProjectStore } from "./project-store";

export class ProjectIpcController {
  #createLocation: CreateProjectLocation | null = null;

  constructor(
    private readonly store: DesktopProjectStore,
    private readonly appState: DesktopAppStateStore,
    private readonly agents: AgentManager,
    private readonly account: DesktopAccountService,
    private readonly cloudMedia: CloudMediaManager,
  ) {}

  async chooseCreateLocation(): Promise<CreateProjectLocation | null> {
    const selection = await dialog.showOpenDialog({
      title: "Choose where to save the new Cinesim project",
      buttonLabel: "Choose folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled) return null;
    const location = { token: randomUUID(), directory: selection.filePaths[0]! };
    this.#createLocation = location;
    return location;
  }

  async create(name: string, kind: "local" | "cloud", locationToken: string) {
    if (kind === "cloud") await this.#requireSignedInAccount();
    const location = this.#createLocation;
    if (!location || location.token !== locationToken)
      throw new Error("Choose where to save the project before creating it");
    this.#createLocation = null;

    const projectId = projectIdSchema.parse(`project_${randomUUID().replaceAll("-", "")}`);
    const cloudProjectId = await this.#registerCloudProject(kind, projectId, name);
    const session = await this.store.create(location.directory, {
      name,
      projectId,
      ...(cloudProjectId ? { cloudProjectId } : {}),
    });
    await this.#remember(session.directory, session.project.name, kind);
    return session;
  }

  async open() {
    const selection = await dialog.showOpenDialog({
      title: "Open a Cinesim project",
      buttonLabel: "Open project",
      properties: ["openDirectory"],
    });
    if (selection.canceled) return null;
    const directory = selection.filePaths[0]!;
    const manifest = await this.#projectManifest(directory);
    await this.#authorizeOpen(directory, this.appState.hasRecent(directory, manifest.kind));
    return this.#openRememberedProject(directory, manifest.kind);
  }

  async openRecent(directory: string) {
    if (!this.appState.hasRecent(directory))
      throw new Error("Project is not in the recent projects list");
    const manifest = await this.#projectManifest(directory);
    if (!this.appState.hasRecent(directory, manifest.kind))
      throw new Error("Project kind does not match its recent project entry");
    await this.#authorizeOpen(directory, true);
    return this.#openRememberedProject(directory, manifest.kind);
  }

  async recentDetails(): Promise<Record<string, RecentProjectDetails>> {
    const projects = this.appState.snapshot().recentProjects;
    const details = await Promise.all(
      projects.map(async (project) => {
        const [size, directoryStats, manifestStats] = await Promise.all([
          canonicalProjectSizeBytes(project.directory).catch(() => null),
          stat(project.directory).catch(() => null),
          stat(resolve(project.directory, "cinesim.toml")).catch(() => null),
        ]);
        return [
          project.directory,
          {
            sizeBytes: size,
            createdAt: directoryStats ? directoryStats.birthtimeMs : null,
            modifiedAt: manifestStats ? manifestStats.mtimeMs : null,
          },
        ] as const;
      }),
    );
    return Object.fromEntries(details);
  }

  updateSettings(update: Parameters<DesktopProjectStore["updateSettings"]>[0]) {
    const current = this.store.session().settings;
    return this.store.updateSettings(settingsSchema.parse({ ...current, ...update }));
  }

  async reveal(): Promise<void> {
    if (!this.store.directory) return;
    const error = await shell.openPath(this.store.directory);
    if (error) throw new Error("The project could not be revealed in Finder");
  }

  async forget(directory: string) {
    this.#requireKnownProject(directory);
    await this.appState.forgetProject(directory);
    return this.appState.snapshot();
  }

  async trash(directory: string) {
    this.#requireKnownProject(directory);
    const canonical = await this.#trashableProjectPath(directory);
    await requireUserIntent({
      title: "Move project to Trash?",
      message: "Move this Cinesim project to the system Trash?",
      detail: canonical,
      confirmLabel: "Move to Trash",
    });
    await this.agents.stopProject(directory);
    if (this.store.directory === directory) await this.store.close();
    await shell.trashItem(canonical);
    await this.agents.removeProject(directory);
    await this.appState.forgetProject(directory);
    return this.appState.snapshot();
  }

  async importMedia() {
    if (!this.store.project) throw new Error("Open a project before importing media");
    const selection = await dialog.showOpenDialog({
      title: "Import media",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Media",
          extensions: ["mp4", "mov", "m4v", "webm", "mkv", "mp3", "wav", "flac"],
        },
      ],
    });
    if (selection.canceled) return null;

    let session = this.store.session();
    const importedAssetIds: string[] = [];
    const managedSourceAssetIds: string[] = [];
    for (const filePath of selection.filePaths) {
      const before = new Set(session.project.assets.map(({ id }) => id));
      const managedCopy = await isTemporaryMediaSelection(filePath);
      session = await this.store.inspectAndImportMedia(filePath, { managedCopy });
      const newAssetIds = session.project.assets
        .filter(({ id }) => !before.has(id))
        .map(({ id }) => id);
      importedAssetIds.push(...newAssetIds);
      if (managedCopy) managedSourceAssetIds.push(...newAssetIds);
    }
    if (this.store.project.cloudProjectId && importedAssetIds.length > 0)
      await this.cloudMedia.queue(importedAssetIds, managedSourceAssetIds);
    return session;
  }

  async #requireSignedInAccount(): Promise<void> {
    const snapshot = await this.account.snapshot();
    if (snapshot.status !== "signed-in" || !snapshot.user)
      throw new Error("Sign in before creating a cloud project");
    this.appState.setAccount(snapshot.user.id);
  }

  async #registerCloudProject(kind: "local" | "cloud", projectId: ProjectId, name: string) {
    if (kind !== "cloud") return undefined;
    const registration = await this.account.registerProject({ clientProjectId: projectId, name });
    return cloudProjectIdSchema.parse(registration.id);
  }

  async #projectManifest(directory: string) {
    const manifest = parseProjectManifest(
      await readFile(resolve(directory, "cinesim.toml"), "utf8"),
    );
    const base = { id: manifest.project.id, name: manifest.project.name };
    return typeof manifest.project.cloudProjectId === "string"
      ? {
          ...base,
          kind: "cloud" as const,
          cloudProjectId: manifest.project.cloudProjectId,
        }
      : { ...base, kind: "local" as const };
  }

  async #authorizeOpen(directory: string, allowOffline: boolean): Promise<void> {
    const manifest = await this.#projectManifest(directory);
    if (manifest.kind === "local") return;
    const user = this.account.requireCachedUser();
    this.appState.setAccount(user.id);
    const snapshot = await this.account.snapshot();
    if (snapshot.status === "offline") {
      if (!allowOffline)
        throw new Error(
          "Connect to the Cinesim service once before opening this project on this device",
        );
      return;
    }
    if (snapshot.status !== "signed-in") throw new Error("Sign in before accessing cloud projects");
    await this.account.registerProject({
      cloudProjectId: manifest.cloudProjectId,
      clientProjectId: manifest.id,
      name: manifest.name,
    });
  }

  async #openRememberedProject(directory: string, kind: "local" | "cloud") {
    const session = await this.store.open(directory);
    await this.#remember(session.directory, session.project.name, kind);
    await this.#reconcileLocalOriginals();
    return session;
  }

  #remember(directory: string, name: string, kind: "local" | "cloud") {
    return this.appState.rememberProject({ name, directory, kind });
  }

  async #reconcileLocalOriginals(): Promise<void> {
    if (!this.store.project?.cloudProjectId) return;
    const assetIds = this.store.project.assets
      .filter((asset) => asset.source.kind === "local" && asset.kind !== "image")
      .map(({ id }) => id);
    if (assetIds.length > 0) await this.cloudMedia.queue(assetIds);
  }

  #requireKnownProject(directory: string): void {
    if (!this.appState.hasRecent(directory) && this.store.directory !== directory)
      throw new Error("Project is not known to Cinesim");
  }

  async #trashableProjectPath(directory: string): Promise<string> {
    const requested = resolve(directory);
    if (requested === parse(requested).root) throw new Error("Cannot trash a filesystem root");
    if ((await lstat(requested)).isSymbolicLink())
      throw new Error("Open the project at its real location before moving it to Trash");
    const canonical = await realpath(requested);
    parseProjectManifest(await readFile(resolve(canonical, "cinesim.toml"), "utf8"));
    return canonical;
  }
}

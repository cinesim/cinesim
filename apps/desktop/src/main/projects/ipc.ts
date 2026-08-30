import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { parse, resolve } from "node:path";
import { dialog, shell } from "electron";
import { z } from "zod";
import { cloudProjectIdSchema, projectIdSchema, settingsSchema } from "@cinesim/core";
import type { AgentManager } from "../agents/manager";
import type { DesktopAccountService } from "../account/service";
import type { CloudMediaManager } from "../cloud/manager";
import type { DesktopAppStateStore } from "../state/app-state-store";
import type { DesktopProjectStore } from "./project-store";
import { canonicalProjectSizeBytes } from "./project-size";
import { isTemporaryMediaSelection } from "./media-import";
import { registerIpcHandler } from "../app/secure-ipc";
import { requireUserIntent } from "../app/user-intent";
import { projectContracts } from "./contracts";

const projectManifestSchema = z.object({
  version: z.literal(1),
  id: projectIdSchema,
  cloudProjectId: cloudProjectIdSchema.optional(),
  name: z.string().min(1),
});

export function registerProjectIpc(
  store: DesktopProjectStore,
  appState: DesktopAppStateStore,
  agents: AgentManager,
  account: DesktopAccountService,
  cloudMedia: CloudMediaManager,
): void {
  async function projectManifest(directory: string) {
    const manifest = projectManifestSchema.parse(
      JSON.parse(await readFile(resolve(directory, "cinesim.json"), "utf8")) as unknown,
    );
    const base = {
      id: manifest.id,
      name: manifest.name,
    };
    return typeof manifest.cloudProjectId === "string"
      ? {
          ...base,
          kind: "cloud" as const,
          cloudProjectId: manifest.cloudProjectId,
        }
      : { ...base, kind: "local" as const };
  }

  async function authorizeOpen(directory: string, allowOffline: boolean): Promise<void> {
    const manifest = await projectManifest(directory);
    if (manifest.kind === "local") return;
    const user = account.requireCachedUser();
    appState.setAccount(user.id);
    const accountSnapshot = await account.snapshot();
    if (accountSnapshot.status === "offline") {
      if (!allowOffline)
        throw new Error(
          "Connect to the Cinesim service once before opening this project on this device",
        );
      return;
    }
    if (accountSnapshot.status !== "signed-in")
      throw new Error("Sign in before accessing cloud projects");
    await account.registerProject({
      cloudProjectId: manifest.cloudProjectId,
      clientProjectId: manifest.id,
      name: manifest.name,
    });
  }

  async function reconcileLocalOriginals(): Promise<void> {
    if (!store.project?.cloudProjectId) return;
    const assetIds =
      store.project?.assets
        .filter((asset) => asset.source.kind === "local" && asset.kind !== "image")
        .map((asset) => asset.id) ?? [];
    if (assetIds.length > 0) await cloudMedia.queue(assetIds);
  }

  registerIpcHandler(projectContracts.create, async ({ name, kind }) => {
    if (kind === "cloud") {
      const accountSnapshot = await account.snapshot();
      if (accountSnapshot.status !== "signed-in" || !accountSnapshot.user)
        throw new Error("Sign in before creating a cloud project");
      appState.setAccount(accountSnapshot.user.id);
    }
    const selection = await dialog.showOpenDialog({
      title: "Choose a parent folder for the new Cinesim project",
      buttonLabel: "Create here",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled) return null;
    const projectId = projectIdSchema.parse(`project_${randomUUID().replaceAll("-", "")}`);
    let cloudProjectId;
    if (kind === "cloud") {
      const registration = await account.registerProject({ clientProjectId: projectId, name });
      cloudProjectId = cloudProjectIdSchema.parse(registration.id);
    }
    const session = await store.create(selection.filePaths[0]!, {
      name,
      projectId,
      ...(cloudProjectId ? { cloudProjectId } : {}),
    });
    await appState.rememberProject({
      name: session.project.name,
      directory: session.directory,
      kind,
    });
    return session;
  });
  registerIpcHandler(projectContracts.open, async () => {
    const selection = await dialog.showOpenDialog({
      title: "Open a Cinesim project",
      buttonLabel: "Open project",
      properties: ["openDirectory"],
    });
    if (selection.canceled) return null;
    const manifest = await projectManifest(selection.filePaths[0]!);
    await authorizeOpen(
      selection.filePaths[0]!,
      appState.hasRecent(selection.filePaths[0]!, manifest.kind),
    );
    const session = await store.open(selection.filePaths[0]!);
    await appState.rememberProject({
      name: session.project.name,
      directory: session.directory,
      kind: manifest.kind,
    });
    await reconcileLocalOriginals();
    return session;
  });
  registerIpcHandler(projectContracts.openRecent, async ({ directory }) => {
    if (!appState.hasRecent(directory))
      throw new Error("Project is not in the recent projects list");
    const manifest = await projectManifest(directory);
    if (!appState.hasRecent(directory, manifest.kind))
      throw new Error("Project kind does not match its recent project entry");
    await authorizeOpen(directory, true);
    const session = await store.open(directory);
    await appState.rememberProject({
      name: session.project.name,
      directory: session.directory,
      kind: manifest.kind,
    });
    await reconcileLocalOriginals();
    return session;
  });
  registerIpcHandler(projectContracts.session, () => (store.project ? store.session() : null));
  registerIpcHandler(projectContracts.recentSizes, async () => {
    const projects = appState.snapshot().recentProjects;
    const sizes = await Promise.all(
      projects.map(async (project) => [
        project.directory,
        await canonicalProjectSizeBytes(project.directory).catch(() => null),
      ]),
    );
    return Object.fromEntries(sizes);
  });
  registerIpcHandler(projectContracts.save, () => store.save());
  registerIpcHandler(projectContracts.settingsUpdate, ({ update }) => {
    const current = store.session().settings;
    const next = settingsSchema.parse({ ...current, ...update });
    return store.updateSettings(next);
  });
  registerIpcHandler(projectContracts.undo, () => store.undo());
  registerIpcHandler(projectContracts.redo, () => store.redo());
  registerIpcHandler(projectContracts.reveal, async () => {
    if (!store.directory) return;
    const error = await shell.openPath(store.directory);
    if (error) throw new Error("The project could not be revealed in Finder");
  });
  registerIpcHandler(projectContracts.forget, async ({ directory }) => {
    if (!appState.hasRecent(directory) && store.directory !== directory)
      throw new Error("Project is not known to Cinesim");
    await appState.forgetProject(directory);
    return appState.snapshot();
  });
  registerIpcHandler(projectContracts.trash, async ({ directory }) => {
    if (!appState.hasRecent(directory) && store.directory !== directory)
      throw new Error("Project is not known to Cinesim");
    const requested = resolve(directory);
    if (requested === parse(requested).root) throw new Error("Cannot trash a filesystem root");
    if ((await lstat(requested)).isSymbolicLink())
      throw new Error("Open the project at its real location before moving it to Trash");
    const canonical = await realpath(requested);
    projectManifestSchema.parse(
      JSON.parse(await readFile(resolve(canonical, "cinesim.json"), "utf8")) as unknown,
    );
    await requireUserIntent({
      title: "Move project to Trash?",
      message: "Move this Cinesim project to the system Trash?",
      detail: canonical,
      confirmLabel: "Move to Trash",
    });
    await agents.stopProject(directory);
    if (store.directory === directory) await store.close();
    await shell.trashItem(canonical);
    await agents.removeProject(directory);
    await appState.forgetProject(directory);
    return appState.snapshot();
  });
  registerIpcHandler(projectContracts.importMedia, async () => {
    if (!store.project) throw new Error("Open a project before importing media");
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
    let session = store.session();
    const importedAssetIds: string[] = [];
    const managedSourceAssetIds: string[] = [];
    for (const filePath of selection.filePaths) {
      const before = new Set(session.project.assets.map((asset) => asset.id));
      const managedCopy = await isTemporaryMediaSelection(filePath);
      session = await store.inspectAndImportMedia(filePath, { managedCopy });
      const newAssetIds = session.project.assets
        .filter((asset) => !before.has(asset.id))
        .map((asset) => asset.id);
      importedAssetIds.push(...newAssetIds);
      if (managedCopy) managedSourceAssetIds.push(...newAssetIds);
    }
    if (store.project.cloudProjectId && importedAssetIds.length > 0)
      await cloudMedia.queue(importedAssetIds, managedSourceAssetIds);
    return session;
  });
  registerIpcHandler(projectContracts.execute, ({ command }) => store.execute(command));
}

import { rm } from "node:fs/promises";
import { BUILTIN_REGISTRY } from "@cinesim/compiler";
import { irProgramToProjectProjection, settingsSchema } from "@cinesim/core";
import type {
  CloudProjectId,
  Project,
  ProjectId,
  ProjectSettings,
  SemanticEditorCommand,
} from "@cinesim/core";
import type { IrDiagnostic } from "@cinesim/ir";
import { projectTimeline } from "@cinesim/ir";
import { createCinesimLogger } from "@cinesim/logging";
import {
  patchManifestSetting,
  sourceRevision,
  SourceCommandService,
  SourceProjectRepository,
  SourceProjectWatcher,
  type SourceProjectSnapshot,
} from "@cinesim/project-io";
import { editorCommandSchema } from "@cinesim/protocol";
import type { DesktopProjectSession } from "../../shared/contracts";
import type { DesktopAccountService } from "../account/service";
import { DerivedMediaStore } from "../derived-media/service";
import { TranscriptStore } from "../transcripts/service";
import { publishDependentProject } from "./dependent-project";
import { inspectMedia } from "./media-import";
import {
  createAvailableProjectDirectory,
  ensureProjectLayout,
  projectDirectorySlug,
} from "./project-layout";
import { stageManagedOriginal } from "./managed-originals";

const log = createCinesimLogger({ service: "desktop-commands" });

const SETTINGS_KEYS: Record<keyof Omit<ProjectSettings, "version">, string> = {
  autosave: "autosave",
  previewQuality: "preview_quality",
  backgroundColor: "background_color",
  defaultFilmstripIntervalSeconds: "filmstrip_interval_seconds",
  proxyGeneration: "proxy_generation",
  proxyProfile: "proxy_profile",
  proxyMaxLongEdge: "proxy_max_long_edge",
  proxyFrameRateCap: "proxy_frame_rate_cap",
  proxyQuality: "proxy_quality",
};

export class DesktopProjectStore {
  readonly derivedMedia = new DerivedMediaStore();
  readonly transcripts: TranscriptStore;
  #directory: string | null = null;
  #commands: SourceCommandService | null = null;
  #snapshot: SourceProjectSnapshot | null = null;
  #watcher: SourceProjectWatcher | null = null;
  #diagnostics: IrDiagnostic[] = [];
  readonly #listeners = new Set<(session: DesktopProjectSession) => void>();
  #revision = 0;
  #operationQueue: Promise<unknown> = Promise.resolve();

  constructor(accountService: DesktopAccountService | null = null) {
    this.transcripts = new TranscriptStore(accountService, (assetId) =>
      this.derivedMedia.sourceFingerprint(assetId),
    );
  }

  get directory(): string | null {
    return this.#directory;
  }

  get project(): Project | null {
    const snapshot = this.#snapshot;
    if (!snapshot) return null;
    return irProgramToProjectProjection(snapshot.compilation.ir, {
      name: snapshot.manifest.project.name,
      assets: snapshot.manifest.assets,
      ...(snapshot.manifest.project.cloudProjectId === undefined
        ? {}
        : {
            cloudProjectId: snapshot.manifest.project.cloudProjectId as Project["cloudProjectId"],
          }),
    });
  }

  subscribe(listener: (session: DesktopProjectSession) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async create(
    parentDirectory: string,
    input:
      | string
      | {
          name: string;
          projectId: ProjectId;
          cloudProjectId?: CloudProjectId | undefined;
        },
  ): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      const name = typeof input === "string" ? input : input.name;
      const directory = await createAvailableProjectDirectory(
        parentDirectory,
        projectDirectorySlug(name),
      );
      const projectId =
        typeof input === "string"
          ? (`project_${crypto.randomUUID().replaceAll("-", "")}` as ProjectId)
          : input.projectId;
      const snapshot = await SourceProjectRepository.create(directory, {
        id: projectId,
        name,
        ...(typeof input === "string" || input.cloudProjectId === undefined
          ? {}
          : { cloudProjectId: input.cloudProjectId }),
      });
      const commands = await SourceCommandService.open(directory);
      await ensureProjectLayout(commands.repository);
      this.#directory = directory;
      this.#commands = commands;
      this.#snapshot = snapshot;
      this.#diagnostics = [];
      this.#revision = 1;
      this.#attachWatcher();
      await this.#publishDependentProject();
      return this.session();
    });
  }

  async open(directory: string): Promise<DesktopProjectSession> {
    const requestedAt = performance.now();
    return this.#serialize(async () => {
      const startedAt = performance.now();
      const operationId = crypto.randomUUID();
      log.info(
        {
          operationId,
          operation: "project-open",
          queueWaitMs: startedAt - requestedAt,
        },
        "project open started",
      );
      try {
        const commands = await SourceCommandService.open(directory);
        await ensureProjectLayout(commands.repository);
        const [snapshot, preparedDerived] = await Promise.all([
          Promise.resolve(commands.snapshot),
          this.derivedMedia.prepareProject(commands.repository.paths.root),
        ]);
        this.#directory = directory;
        this.#commands = commands;
        this.#snapshot = snapshot;
        this.#diagnostics = [];
        this.#revision += 1;
        this.#attachWatcher();
        const derivedStartedAt = performance.now();
        await publishDependentProject({
          derivedMedia: this.derivedMedia,
          transcripts: this.transcripts,
          directory,
          project: this.#requireProject(),
          settings: snapshot.manifest.settings,
          preparedDerived,
        });
        const session = this.session();
        log.info(
          {
            operationId,
            operation: "project-open",
            projectId: session.project.id,
            projectRevision: session.revision,
            queueWaitMs: startedAt - requestedAt,
            derivedDurationMs: performance.now() - derivedStartedAt,
            durationMs: performance.now() - startedAt,
          },
          "project open completed",
        );
        return session;
      } catch (error) {
        log.error(
          {
            err: error,
            operationId,
            operation: "project-open",
            queueWaitMs: startedAt - requestedAt,
            durationMs: performance.now() - startedAt,
          },
          "project open failed",
        );
        throw error;
      }
    });
  }

  async save(): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      this.#snapshot = await this.#requireCommands().refresh();
      this.#watcher?.acceptPublished(this.#snapshot);
      this.#revision += 1;
      return this.session();
    });
  }

  async updateSettings(update: Partial<ProjectSettings>): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      const current = this.#requireSnapshot();
      const settings = settingsSchema.parse({
        ...current.manifest.settings,
        ...update,
      });
      let manifestSource = current.manifestSource;
      for (const [key, tomlKey] of Object.entries(SETTINGS_KEYS) as Array<
        [keyof typeof SETTINGS_KEYS, string]
      >) {
        if (settings[key] === current.manifest.settings[key]) continue;
        manifestSource = patchManifestSetting(
          manifestSource,
          tomlKey,
          settings[key],
          sourceRevision(manifestSource),
        );
      }
      await this.#requireCommands().repository.commit({
        expectedGeneration: current.generation,
        manifestSource,
        expectedProgram: current.compilation.ir,
      });
      this.#snapshot = await this.#requireCommands().refresh();
      this.#watcher?.acceptPublished(this.#snapshot);
      this.#revision += 1;
      await this.derivedMedia
        .updateSettings(settings)
        .catch((error: unknown) =>
          log.warn({ err: error, operation: "settings-update" }, "derived settings refresh failed"),
        );
      return this.session();
    });
  }

  async execute(input: SemanticEditorCommand, expectedGeneration?: string) {
    return this.#serialize(async () => {
      const command = editorCommandSchema.parse(input);
      const operationId = crypto.randomUUID();
      const startedAt = Date.now();
      log.info({ operationId, operation: command.type }, "command started");
      try {
        const result = await this.#requireCommands().execute(command, expectedGeneration);
        this.#snapshot = result.snapshot;
        this.#watcher?.acceptPublished(result.snapshot);
        this.#diagnostics = [];
        const project = this.#requireProject();
        this.derivedMedia.updateProject(project);
        this.#revision += 1;
        await this.transcripts
          .updateProject(project)
          .catch((error: unknown) =>
            log.warn({ err: error, operation: command.type }, "transcript refresh failed"),
          );
        await this.derivedMedia
          .pruneRemovedAssets()
          .catch((error: unknown) =>
            log.warn(
              { err: error, operation: command.type },
              "canonical edit completed but derived cleanup failed",
            ),
          );
        const {
          snapshot: _snapshot,
          program: _program,
          patches: _patches,
          manifest: _manifest,
          command: _command,
          ...response
        } = result;
        log.info(
          {
            operationId,
            operation: command.type,
            projectRevision: this.#revision,
            durationMs: Date.now() - startedAt,
            changedIds: response.changedIds,
            createdIds: response.createdIds,
          },
          "command completed",
        );
        return { session: this.session(), result: response };
      } catch (error) {
        log.error(
          {
            err: error,
            operationId,
            operation: command.type,
            durationMs: Date.now() - startedAt,
          },
          "command failed",
        );
        throw error;
      }
    });
  }

  async undo(): Promise<DesktopProjectSession> {
    return this.#serialize(() => this.#moveHistory("undo"));
  }

  async redo(): Promise<DesktopProjectSession> {
    return this.#serialize(() => this.#moveHistory("redo"));
  }

  async #moveHistory(direction: "undo" | "redo"): Promise<DesktopProjectSession> {
    const commands = this.#requireCommands();
    if (direction === "undo" ? !commands.canUndo : !commands.canRedo) return this.session();
    this.#snapshot = direction === "undo" ? await commands.undo() : await commands.redo();
    this.#watcher?.acceptPublished(this.#snapshot);
    this.#diagnostics = [];
    const project = this.#requireProject();
    this.derivedMedia.updateProject(project);
    this.#revision += 1;
    await this.transcripts
      .updateProject(project)
      .catch((error: unknown) =>
        log.warn({ err: error, operation: direction }, "transcript refresh failed"),
      );
    await this.derivedMedia
      .pruneRemovedAssets()
      .catch((error: unknown) =>
        log.warn({ err: error, operation: direction }, `derived cleanup after ${direction} failed`),
      );
    return this.session();
  }

  async inspectAndImportMedia(
    filePath: string,
    options: { managedCopy?: boolean } = {},
  ): Promise<DesktopProjectSession> {
    const project = this.#requireProject();
    let asset = await inspectMedia(
      filePath,
      project.assets.map((candidate) => candidate.id),
    );
    let managedPath: string | null = null;
    if (options.managedCopy) {
      managedPath = await stageManagedOriginal({
        repository: this.#requireCommands().repository,
        projectDirectory: this.#requireDirectory(),
        sourcePath: filePath,
        assetId: asset.id,
      });
      asset = { ...asset, source: { kind: "local", path: managedPath } };
    }
    try {
      await this.execute({ type: "asset.import", asset });
      return this.session();
    } catch (error) {
      if (managedPath) await rm(managedPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  assetPath(assetId: string): string | null {
    const source = this.project?.assets.find((asset) => asset.id === assetId)?.source;
    return source?.kind === "local" ? source.path : null;
  }

  async close(): Promise<void> {
    await this.#serialize(async () => {
      await this.derivedMedia.clearProject();
      await this.transcripts.clearProject();
      this.#directory = null;
      this.#watcher?.close();
      this.#watcher = null;
      this.#commands = null;
      this.#snapshot = null;
      this.#diagnostics = [];
      this.#revision += 1;
    });
  }

  session(): DesktopProjectSession {
    const snapshot = this.#requireSnapshot();
    const commands = this.#requireCommands();
    return {
      directory: this.#requireDirectory(),
      derivedScope: this.derivedMedia.scope(),
      project: this.#requireProject(),
      program: structuredClone(snapshot.compilation.ir),
      timeline: projectTimeline(snapshot.compilation.ir, snapshot.compilation.sourceMap),
      timelines: Object.fromEntries(
        snapshot.compilation.ir.compositions.map((composition) => [
          composition.id,
          projectTimeline(snapshot.compilation.ir, snapshot.compilation.sourceMap, composition.id),
        ]),
      ),
      editMap: structuredClone(snapshot.compilation.sourceMap),
      propertySchemas: structuredClone(BUILTIN_REGISTRY),
      diagnostics: structuredClone(
        this.#diagnostics.length > 0 ? this.#diagnostics : snapshot.compilation.diagnostics,
      ),
      settings: structuredClone(snapshot.manifest.settings),
      generation: snapshot.generation,
      revision: this.#revision,
      canUndo: commands.canUndo,
      canRedo: commands.canRedo,
    };
  }

  #requireDirectory(): string {
    if (!this.#directory) throw new Error("No project is open");
    return this.#directory;
  }

  #requireProject(): Project {
    const project = this.project;
    if (!project) throw new Error("No project is open");
    return project;
  }

  #requireCommands(): SourceCommandService {
    if (!this.#commands) throw new Error("No project is open");
    return this.#commands;
  }

  #requireSnapshot(): SourceProjectSnapshot {
    if (!this.#snapshot) throw new Error("No project is open");
    return this.#snapshot;
  }

  async #publishDependentProject(): Promise<void> {
    await publishDependentProject({
      derivedMedia: this.derivedMedia,
      transcripts: this.transcripts,
      directory: this.#requireDirectory(),
      project: this.#requireProject(),
      settings: this.#requireSnapshot().manifest.settings,
    });
  }

  #attachWatcher(): void {
    this.#watcher?.close();
    const commands = this.#requireCommands();
    this.#watcher = new SourceProjectWatcher(commands.repository, this.#requireSnapshot(), {
      accepted: (snapshot) => {
        void this.#serialize(async () => {
          commands.acceptExternal(snapshot);
          this.#snapshot = snapshot;
          this.#diagnostics = [];
          this.#revision += 1;
          const project = this.#requireProject();
          this.derivedMedia.updateProject(project);
          await this.transcripts.updateProject(project).catch(() => undefined);
          this.#notify();
        });
      },
      diagnostics: (diagnostics) => {
        this.#diagnostics = diagnostics;
        this.#revision += 1;
        this.#notify();
      },
    });
    this.#watcher.start();
  }

  #notify(): void {
    if (!this.#snapshot || !this.#directory) return;
    const session = this.session();
    for (const listener of this.#listeners) listener(session);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.catch(() => undefined).then(operation);
    this.#operationQueue = result;
    return result;
  }
}

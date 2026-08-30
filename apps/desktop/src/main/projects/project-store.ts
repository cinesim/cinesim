import { rm } from "node:fs/promises";
import { createProject, DEFAULT_SETTINGS, ProjectHistory, settingsSchema } from "@cinesim/core";
import type { EditorCommand, Project, ProjectSettings } from "@cinesim/core";
import type { CloudProjectId, ProjectId } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { CanonicalProjectRepository } from "@cinesim/project-io";
import { dispatchCommand } from "@cinesim/protocol";
import type { DesktopProjectSession } from "../../shared/contracts";
import { DerivedMediaStore } from "../derived-media/service";
import type { DesktopAccountService } from "../account/service";
import { TranscriptStore } from "../transcripts/service";
import { inspectMedia } from "./media-import";
import {
  createAvailableProjectDirectory,
  ensureProjectLayout,
  projectDirectorySlug,
} from "./project-layout";
import { stageManagedOriginal } from "./managed-originals";
import { publishDependentProject } from "./dependent-project";

const log = createCinesimLogger({ service: "desktop-commands" });

export class DesktopProjectStore {
  readonly derivedMedia = new DerivedMediaStore();
  readonly transcripts: TranscriptStore;
  #directory: string | null = null;
  #history: ProjectHistory | null = null;
  #settings: ProjectSettings = DEFAULT_SETTINGS;
  #revision = 0;
  #repository: CanonicalProjectRepository | null = null;
  #generation: string | null = null;
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
    return this.#history?.project ?? null;
  }

  async create(
    parentDirectory: string,
    input:
      | string
      | { name: string; projectId: ProjectId; cloudProjectId?: CloudProjectId | undefined },
  ): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      const name = typeof input === "string" ? input : input.name;
      const slug = projectDirectorySlug(name);
      const directory = await createAvailableProjectDirectory(parentDirectory, slug);
      const project = createProject({
        ...(typeof input === "string"
          ? {}
          : {
              id: input.projectId,
              ...(input.cloudProjectId ? { cloudProjectId: input.cloudProjectId } : {}),
            }),
        name,
      });
      const repository = await CanonicalProjectRepository.open(directory);
      await ensureProjectLayout(repository);
      const generation = await repository.commit({
        project,
        settings: DEFAULT_SETTINGS,
        expectedGeneration: null,
      });
      this.#directory = directory;
      this.#repository = repository;
      this.#history = new ProjectHistory(project);
      this.#settings = DEFAULT_SETTINGS;
      this.#generation = generation;
      this.#revision = 1;
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
        { operationId, operation: "project-open", queueWaitMs: startedAt - requestedAt },
        "project open started",
      );
      try {
        const readsStartedAt = performance.now();
        const repository = await CanonicalProjectRepository.open(directory);
        await ensureProjectLayout(repository);
        const [snapshot, preparedDerived] = await Promise.all([
          repository.load(),
          this.derivedMedia.prepareProject(repository.paths.root),
        ]);
        const readDurationMs = performance.now() - readsStartedAt;
        this.#directory = directory;
        this.#repository = repository;
        this.#history = new ProjectHistory(snapshot.project);
        this.#settings = snapshot.settings;
        this.#generation = snapshot.generation;
        this.#revision += 1;
        const layoutDurationMs = 0;
        const derivedStartedAt = performance.now();
        await publishDependentProject({
          derivedMedia: this.derivedMedia,
          transcripts: this.transcripts,
          directory,
          project: this.#history.project,
          settings: this.#settings,
          preparedDerived,
        });
        const derivedDurationMs = performance.now() - derivedStartedAt;
        const session = this.session();
        log.info(
          {
            operationId,
            operation: "project-open",
            projectId: session.project.id,
            projectRevision: session.revision,
            queueWaitMs: startedAt - requestedAt,
            readDurationMs,
            layoutDurationMs,
            derivedDurationMs,
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
    return this.#serialize(() => this.#persist());
  }

  async updateSettings(update: Partial<ProjectSettings>): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      const settings = settingsSchema.parse({ ...this.#settings, ...update });
      const generation = await this.#commit(this.#requireProject(), settings);
      this.#settings = settings;
      this.#generation = generation;
      this.#revision += 1;
      await this.derivedMedia
        .updateSettings(this.#settings)
        .catch((error: unknown) =>
          log.warn({ err: error, operation: "settings-update" }, "derived settings refresh failed"),
        );
      return this.session();
    });
  }

  async #persist(): Promise<DesktopProjectSession> {
    this.#generation = await this.#commit(this.#requireProject(), this.#settings);
    return this.session();
  }

  async execute(command: EditorCommand) {
    return this.#serialize(async () => {
      const operationId = crypto.randomUUID();
      const startedAt = Date.now();
      log.info({ operationId, operation: command.type }, "command started");
      try {
        const project = this.#requireProject();
        const dispatched = dispatchCommand(project, command);
        if (!dispatched.ok) {
          const error = new Error(`${dispatched.error.code}: ${dispatched.error.message}`);
          (error as Error & { code: string }).code = dispatched.error.code;
          throw error;
        }
        const generation = await this.#commit(dispatched.value.project, this.#settings);
        this.#history!.commitApplied(dispatched.value);
        this.#generation = generation;
        this.derivedMedia.updateProject(this.#history!.project);
        this.#revision += 1;
        await this.transcripts
          .updateProject(this.#history!.project)
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
        const { project: _project, ...result } = dispatched.value;
        log.info(
          {
            operationId,
            operation: command.type,
            projectRevision: this.#revision,
            durationMs: Date.now() - startedAt,
            changedIds: result.changedIds,
            createdIds: result.createdIds,
          },
          "command completed",
        );
        return { session: this.session(), result };
      } catch (error) {
        log.error(
          { err: error, operationId, operation: command.type, durationMs: Date.now() - startedAt },
          "command failed",
        );
        throw error;
      }
    });
  }

  async undo(): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      this.#requireProject();
      const project = this.#history!.peekUndo();
      if (!project) return this.session();
      const generation = await this.#commit(project, this.#settings);
      this.#history!.undo();
      this.#generation = generation;
      this.derivedMedia.updateProject(this.#history!.project);
      this.#revision += 1;
      await this.transcripts
        .updateProject(this.#history!.project)
        .catch((error: unknown) =>
          log.warn({ err: error, operation: "undo" }, "transcript refresh failed"),
        );
      const session = this.session();
      await this.derivedMedia
        .pruneRemovedAssets()
        .catch((error: unknown) =>
          log.warn({ err: error, operation: "undo" }, "derived cleanup after undo failed"),
        );
      return session;
    });
  }

  async redo(): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      this.#requireProject();
      const project = this.#history!.peekRedo();
      if (!project) return this.session();
      const generation = await this.#commit(project, this.#settings);
      this.#history!.redo();
      this.#generation = generation;
      this.derivedMedia.updateProject(this.#history!.project);
      this.#revision += 1;
      await this.transcripts
        .updateProject(this.#history!.project)
        .catch((error: unknown) =>
          log.warn({ err: error, operation: "redo" }, "transcript refresh failed"),
        );
      const session = this.session();
      await this.derivedMedia
        .pruneRemovedAssets()
        .catch((error: unknown) =>
          log.warn({ err: error, operation: "redo" }, "derived cleanup after redo failed"),
        );
      return session;
    });
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
        repository: this.#requireRepository(),
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
      this.#history = null;
      this.#settings = DEFAULT_SETTINGS;
      this.#repository = null;
      this.#generation = null;
      this.#revision += 1;
    });
  }

  session(): DesktopProjectSession {
    return {
      directory: this.#requireDirectory(),
      derivedScope: this.derivedMedia.scope(),
      project: this.#requireProject(),
      settings: structuredClone(this.#settings),
      revision: this.#revision,
      canUndo: this.#history!.canUndo,
      canRedo: this.#history!.canRedo,
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

  async #commit(project: Project, settings: ProjectSettings): Promise<string> {
    return this.#requireRepository().commit({
      project,
      settings,
      expectedGeneration: this.#generation,
    });
  }

  async #publishDependentProject(): Promise<void> {
    const directory = this.#requireDirectory();
    const project = this.#requireProject();
    await publishDependentProject({
      derivedMedia: this.derivedMedia,
      transcripts: this.transcripts,
      directory,
      project,
      settings: this.#settings,
    });
  }

  #requireRepository(): CanonicalProjectRepository {
    if (!this.#repository) throw new Error("No project is open");
    return this.#repository;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.catch(() => undefined).then(operation);
    this.#operationQueue = result;
    return result;
  }
}

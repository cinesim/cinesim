import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createProject,
  DEFAULT_SETTINGS,
  joinProjectFiles,
  PROJECT_FILES,
  ProjectHistory,
  settingsFromToml,
  settingsToToml,
  settingsSchema,
  splitProjectFiles,
  stableJson,
} from "@cinesim/core";
import type { EditorCommand, Project, ProjectSettings } from "@cinesim/core";
import type { CloudProjectId, ProjectId } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { dispatchCommand } from "@cinesim/protocol";
import type { DesktopProjectSession } from "../../shared/api";
import { DerivedMediaStore } from "../derived-media/service";
import type { DesktopAccountService } from "../account/service";
import { TranscriptStore } from "../transcripts/service";
import { inspectMedia } from "./media-import";

const log = createCinesimLogger({ service: "desktop-commands" });

const PROJECT_AGENTS = `# Project creative direction

This is a Cinesim video editing project.

- Prefer the Cinesim CLI or MCP tools for timeline edits.
- Canonical state is \`cinesim.json\` and \`.cinesim/\`.
- Human-readable settings are in \`.cinesim/settings.toml\`.
- \`.video/\` contains generated caches, optional downloaded originals, proxies, perception
  artifacts, and runtime files.
- Derived files may be deleted and regenerated. Do not edit them manually.
- Cinesim may offload originals under the signed-in account's storage policy. Agents must not move
  or modify source media directly.

Add creative direction below this line.
`;

const PROJECT_GITIGNORE = `.video/
.DS_Store
`;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const tempPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, path);
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    await writeFile(path, contents, "utf8");
  }
}

async function createAvailableProjectDirectory(
  parentDirectory: string,
  slug: string,
): Promise<string> {
  for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
    const directory = join(parentDirectory, ordinal === 1 ? slug : `${slug}-${ordinal}`);
    try {
      await mkdir(directory, { recursive: false });
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not find an available folder for ${slug}`);
}

export class DesktopProjectStore {
  readonly derivedMedia = new DerivedMediaStore();
  readonly transcripts: TranscriptStore;
  #directory: string | null = null;
  #history: ProjectHistory | null = null;
  #settings: ProjectSettings = DEFAULT_SETTINGS;
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
      const slug =
        name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "untitled-project";
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
      this.#directory = directory;
      this.#history = new ProjectHistory(project);
      this.#settings = DEFAULT_SETTINGS;
      this.#revision = 1;
      await this.#ensureLayout();
      await this.derivedMedia.setProject(directory, project, undefined, this.#settings);
      await this.transcripts.setProject(directory, project, this.derivedMedia.scope());
      return this.#persist();
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
        const [manifest, assets, timeline, settingsSource, preparedDerived] = await Promise.all([
          readJson(join(directory, PROJECT_FILES.manifest)),
          readJson(join(directory, PROJECT_FILES.assets)),
          readJson(join(directory, PROJECT_FILES.timeline)),
          readFile(join(directory, PROJECT_FILES.settings), "utf8"),
          this.derivedMedia.prepareProject(directory),
        ]);
        const readDurationMs = performance.now() - readsStartedAt;
        const settings = settingsFromToml(settingsSource);
        this.#directory = directory;
        this.#history = new ProjectHistory(joinProjectFiles(manifest, assets, timeline));
        this.#settings = settings;
        this.#revision += 1;
        const layoutStartedAt = performance.now();
        await this.#ensureLayout();
        const layoutDurationMs = performance.now() - layoutStartedAt;
        const derivedStartedAt = performance.now();
        await this.derivedMedia.setProject(
          directory,
          this.#history.project,
          preparedDerived,
          this.#settings,
        );
        await this.transcripts.setProject(
          directory,
          this.#history.project,
          this.derivedMedia.scope(),
        );
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

  async #ensureLayout(): Promise<void> {
    const directory = this.#requireDirectory();
    await Promise.all([
      mkdir(join(directory, ".cinesim"), { recursive: true }),
      ...[
        "cache",
        "proxies",
        "originals",
        "thumbnails",
        "waveforms",
        "filmstrips",
        "frames",
        "runtime",
        "transcripts",
      ].map((folder) => mkdir(join(directory, ".video", folder), { recursive: true })),
    ]);
    await Promise.all([
      writeIfMissing(join(directory, "AGENTS.md"), PROJECT_AGENTS),
      writeIfMissing(join(directory, ".gitignore"), PROJECT_GITIGNORE),
    ]);
  }

  async save(): Promise<DesktopProjectSession> {
    return this.#serialize(() => this.#persist());
  }

  async updateSettings(update: Partial<ProjectSettings>): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      this.#settings = settingsSchema.parse({ ...this.#settings, ...update });
      this.#revision += 1;
      await this.derivedMedia.updateSettings(this.#settings);
      return this.#persist();
    });
  }

  async #persist(): Promise<DesktopProjectSession> {
    const directory = this.#requireDirectory();
    const files = splitProjectFiles(this.#requireProject());
    await Promise.all([
      atomicWrite(join(directory, PROJECT_FILES.manifest), stableJson(files.manifest)),
      atomicWrite(join(directory, PROJECT_FILES.assets), stableJson(files.assets)),
      atomicWrite(join(directory, PROJECT_FILES.timeline), stableJson(files.timeline)),
      atomicWrite(join(directory, PROJECT_FILES.settings), settingsToToml(this.#settings)),
    ]);
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
        this.#history!.commit(dispatched.value.command);
        this.derivedMedia.updateProject(this.#history!.project);
        await this.transcripts.updateProject(this.#history!.project);
        this.#revision += 1;
        await this.#persist();
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
      this.#history!.undo();
      this.derivedMedia.updateProject(this.#history!.project);
      await this.transcripts.updateProject(this.#history!.project);
      this.#revision += 1;
      const session = await this.#persist();
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
      this.#history!.redo();
      this.derivedMedia.updateProject(this.#history!.project);
      await this.transcripts.updateProject(this.#history!.project);
      this.#revision += 1;
      const session = await this.#persist();
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
      const originalsDirectory = await this.#managedOriginalsDirectory();
      managedPath = join(originalsDirectory, asset.id);
      const temporaryPath = `${managedPath}.${randomUUID()}.tmp`;
      if (await lstat(managedPath).catch(() => null))
        throw new Error("The managed original already exists");
      let published = false;
      try {
        await copyFile(filePath, temporaryPath, constants.COPYFILE_EXCL);
        const [sourceInfo, copyInfo] = await Promise.all([stat(filePath), stat(temporaryPath)]);
        if (!sourceInfo.isFile() || !copyInfo.isFile() || sourceInfo.size !== copyInfo.size)
          throw new Error("The managed original copy could not be verified");
        await link(temporaryPath, managedPath);
        published = true;
        await rm(temporaryPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        if (published) await rm(managedPath, { force: true }).catch(() => undefined);
        throw error;
      }
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

  async #managedOriginalsDirectory(): Promise<string> {
    const videoDirectory = join(this.#requireDirectory(), ".video");
    const originalsDirectory = join(videoDirectory, "originals");
    const [videoInfo, originalsInfo] = await Promise.all([
      lstat(videoDirectory),
      lstat(originalsDirectory),
    ]);
    if (
      videoInfo.isSymbolicLink() ||
      !videoInfo.isDirectory() ||
      originalsInfo.isSymbolicLink() ||
      !originalsInfo.isDirectory()
    )
      throw new Error("Managed originals must stay inside .video");
    return originalsDirectory;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.catch(() => undefined).then(operation);
    this.#operationQueue = result;
    return result;
  }
}

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createProject,
  DEFAULT_SETTINGS,
  joinProjectFiles,
  nextId,
  PROJECT_FILES,
  ProjectHistory,
  settingsFromToml,
  settingsToToml,
  splitProjectFiles,
  stableJson,
} from "@cinesim/core";
import type { Asset, EditorCommand, Project, ProjectSettings } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { dispatchCommand } from "@cinesim/protocol";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
import type { DesktopProjectSession } from "../shared/api";
import { DerivedMediaStore } from "./derived-media-store";

const log = createCinesimLogger({ service: "desktop-commands" });

const PROJECT_AGENTS = `# Project creative direction

This is a Cinesim video editing project.

- Prefer the Cinesim CLI or MCP tools for timeline edits.
- Canonical state is \`cinesim.json\` and \`.cinesim/\`.
- Human-readable settings are in \`.cinesim/settings.toml\`.
- \`.video/\` contains generated caches, proxies, perception artifacts, and runtime files.
- Derived files may be deleted and regenerated. Do not edit them manually.
- Source media is referenced in place and must not be moved or modified without user direction.

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

export class DesktopProjectStore {
  readonly derivedMedia = new DerivedMediaStore();
  #directory: string | null = null;
  #history: ProjectHistory | null = null;
  #settings: ProjectSettings = DEFAULT_SETTINGS;
  #revision = 0;
  #operationQueue: Promise<unknown> = Promise.resolve();

  get directory(): string | null {
    return this.#directory;
  }

  get project(): Project | null {
    return this.#history?.project ?? null;
  }

  async create(parentDirectory: string, name: string): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      const slug =
        name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "untitled-project";
      const directory = join(parentDirectory, slug);
      await mkdir(directory, { recursive: false });
      const project = createProject({ name });
      this.#directory = directory;
      this.#history = new ProjectHistory(project);
      this.#settings = DEFAULT_SETTINGS;
      this.#revision = 1;
      await this.#ensureLayout();
      await this.derivedMedia.setProject(directory, project);
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
        await this.derivedMedia.setProject(directory, this.#history.project, preparedDerived);
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
      ...["cache", "proxies", "thumbnails", "waveforms", "filmstrips", "frames", "runtime"].map(
        (folder) => mkdir(join(directory, ".video", folder), { recursive: true }),
      ),
    ]);
    await Promise.all([
      writeIfMissing(join(directory, "AGENTS.md"), PROJECT_AGENTS),
      writeIfMissing(join(directory, ".gitignore"), PROJECT_GITIGNORE),
    ]);
  }

  async save(): Promise<DesktopProjectSession> {
    return this.#serialize(() => this.#persist());
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
        this.#revision += 1;
        await this.#persist();
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
      this.#revision += 1;
      return this.#persist();
    });
  }

  async redo(): Promise<DesktopProjectSession> {
    return this.#serialize(async () => {
      this.#requireProject();
      this.#history!.redo();
      this.derivedMedia.updateProject(this.#history!.project);
      this.#revision += 1;
      return this.#persist();
    });
  }

  async inspectAndImportMedia(filePath: string): Promise<DesktopProjectSession> {
    const project = this.#requireProject();
    const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
    try {
      if (!(await input.canRead())) throw new Error("Unsupported media file");
      const [video, audio, durationSeconds] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
        input.computeDuration(),
      ]);
      const existingIds = project.assets.map((asset) => asset.id);
      const asset: Asset = {
        id: nextId("asset", existingIds),
        kind: video ? "video" : audio ? "audio" : "image",
        name: basename(filePath),
        source: { kind: "local", path: filePath },
        durationUs: Math.max(1, Math.round(durationSeconds * 1_000_000)),
        ...(video
          ? {
              width: await video.getDisplayWidth(),
              height: await video.getDisplayHeight(),
              frameRate: (await video.computeFrameRateMetrics({ targetPacketCount: 128 }))
                .bestGuessFrameRate,
            }
          : {}),
        hasAudio: Boolean(audio),
      };
      await this.execute({ type: "asset.import", asset });
      return this.session();
    } finally {
      input.dispose();
    }
  }

  assetPath(assetId: string): string | null {
    return this.project?.assets.find((asset) => asset.id === assetId)?.source.path ?? null;
  }

  session(): DesktopProjectSession {
    return {
      directory: this.#requireDirectory(),
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

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.catch(() => undefined).then(operation);
    this.#operationQueue = result;
    return result;
  }
}

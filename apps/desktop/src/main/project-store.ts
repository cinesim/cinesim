import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
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
import { dispatchCommand } from "@cinesim/protocol";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
import type { DesktopProjectSession } from "../shared/api";

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
  #directory: string | null = null;
  #history: ProjectHistory | null = null;
  #settings: ProjectSettings = DEFAULT_SETTINGS;

  get directory(): string | null {
    return this.#directory;
  }

  get project(): Project | null {
    return this.#history?.project ?? null;
  }

  async create(parentDirectory: string, name: string): Promise<DesktopProjectSession> {
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
    await this.#ensureLayout();
    await this.save();
    return this.session();
  }

  async open(directory: string): Promise<DesktopProjectSession> {
    const manifest = await readJson(join(directory, PROJECT_FILES.manifest));
    const assets = await readJson(join(directory, PROJECT_FILES.assets));
    const timeline = await readJson(join(directory, PROJECT_FILES.timeline));
    const settings = settingsFromToml(
      await readFile(join(directory, PROJECT_FILES.settings), "utf8"),
    );
    this.#directory = directory;
    this.#history = new ProjectHistory(joinProjectFiles(manifest, assets, timeline));
    this.#settings = settings;
    await this.#ensureLayout();
    return this.session();
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
    const project = this.#requireProject();
    const dispatched = dispatchCommand(project, command);
    if (!dispatched.ok) throw new Error(`${dispatched.error.code}: ${dispatched.error.message}`);
    this.#history!.commit(dispatched.value.command);
    await this.save();
    const { project: _project, ...result } = dispatched.value;
    return { session: this.session(), result };
  }

  async undo(): Promise<DesktopProjectSession> {
    this.#requireProject();
    this.#history!.undo();
    return this.save();
  }

  async redo(): Promise<DesktopProjectSession> {
    this.#requireProject();
    this.#history!.redo();
    return this.save();
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
      canUndo: this.#history!.canUndo,
      canRedo: this.#history!.canRedo,
    };
  }

  async readRange(
    assetId: string,
    start: number,
    endExclusive: number,
  ): Promise<{ data: Buffer; size: number }> {
    const path = this.assetPath(assetId);
    if (!path) throw new Error("Unknown asset");
    const info = await stat(path);
    const safeStart = Math.max(0, Math.min(start, info.size));
    const safeEnd = Math.max(
      safeStart,
      Math.min(endExclusive, info.size, safeStart + 16 * 1024 * 1024),
    );
    const handle = await open(path, "r");
    try {
      const data = Buffer.alloc(safeEnd - safeStart);
      await handle.read(data, 0, data.byteLength, safeStart);
      return { data, size: info.size };
    } finally {
      await handle.close();
    }
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
}

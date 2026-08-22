import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DesktopAppState, ProjectViewState, RecentProject } from "../shared/api";

const EMPTY_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  projectViews: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecentProject(value: unknown): RecentProject | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.directory !== "string")
    return null;
  return { name: value.name, directory: value.directory };
}

function parseProjectView(value: unknown): ProjectViewState | null {
  if (!isRecord(value) || !Array.isArray(value.openSequenceIds)) return null;
  const openSequenceIds = value.openSequenceIds.filter(
    (id): id is string => typeof id === "string" && /^sequence_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id),
  );
  const activeTab =
    value.activeTab === "media" ||
    (typeof value.activeTab === "string" && openSequenceIds.includes(value.activeTab))
      ? value.activeTab
      : "media";
  return { openSequenceIds: [...new Set(openSequenceIds)], activeTab };
}

function parseState(value: unknown): DesktopAppState {
  if (!isRecord(value) || value.version !== 1) return structuredClone(EMPTY_STATE);
  const recentProjects = Array.isArray(value.recentProjects)
    ? value.recentProjects
        .map(parseRecentProject)
        .filter((project): project is RecentProject => project !== null)
        .slice(0, 12)
    : [];
  const projectViews: Record<string, ProjectViewState> = {};
  if (isRecord(value.projectViews)) {
    for (const [directory, candidate] of Object.entries(value.projectViews)) {
      const view = parseProjectView(candidate);
      if (view) projectViews[directory] = view;
    }
  }
  return { version: 1, recentProjects, projectViews };
}

export class DesktopAppStateStore {
  #state: DesktopAppState = structuredClone(EMPTY_STATE);
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.#state = parseState(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch {
      this.#state = structuredClone(EMPTY_STATE);
    }
  }

  snapshot(): DesktopAppState {
    return structuredClone(this.#state);
  }

  hasRecent(directory: string): boolean {
    return this.#state.recentProjects.some((project) => project.directory === directory);
  }

  async rememberProject(project: RecentProject): Promise<void> {
    this.#state.recentProjects = [
      project,
      ...this.#state.recentProjects.filter((recent) => recent.directory !== project.directory),
    ].slice(0, 12);
    await this.#queueSave();
  }

  async setProjectView(directory: string, view: ProjectViewState): Promise<void> {
    this.#state.projectViews[directory] = structuredClone(view);
    await this.#queueSave();
  }

  async #queueSave(): Promise<void> {
    const contents = `${JSON.stringify(this.#state, null, 2)}\n`;
    const write = this.#writeQueue.catch(() => undefined).then(() => this.#save(contents));
    this.#writeQueue = write;
    await write;
  }

  async #save(contents: string): Promise<void> {
    const temporaryPath = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, this.path);
  }
}

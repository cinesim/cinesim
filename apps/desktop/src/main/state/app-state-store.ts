import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_EDITOR_LAYOUT, EDITOR_LAYOUT_LIMITS } from "../../shared/api";
import type { DesktopAppState, EditorLayoutState, RecentProject } from "../../shared/api";

const EMPTY_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  mediaPoolOpenByProject: {},
  inspectorOpenByProject: {},
  notesOpenByProject: {},
  editorLayoutsByProject: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecentProject(value: unknown): RecentProject | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.directory !== "string")
    return null;
  return { name: value.name, directory: value.directory };
}

export function parseEditorLayoutState(value: unknown): EditorLayoutState | null {
  if (!isRecord(value)) return null;
  const fields = ["mediaPoolWidth", "inspectorWidth", "timelineHeight"] as const;
  for (const field of fields) {
    const size = value[field];
    const limits = EDITOR_LAYOUT_LIMITS[field];
    if (
      typeof size !== "number" ||
      !Number.isFinite(size) ||
      size < limits.min ||
      size > limits.max
    )
      return null;
  }
  const notesWidth = value.notesWidth ?? DEFAULT_EDITOR_LAYOUT.notesWidth;
  if (
    typeof notesWidth !== "number" ||
    !Number.isFinite(notesWidth) ||
    notesWidth < EDITOR_LAYOUT_LIMITS.notesWidth.min ||
    notesWidth > EDITOR_LAYOUT_LIMITS.notesWidth.max
  )
    return null;
  return {
    mediaPoolWidth: value.mediaPoolWidth as number,
    inspectorWidth: value.inspectorWidth as number,
    notesWidth,
    timelineHeight: value.timelineHeight as number,
  };
}

function parseState(value: unknown): DesktopAppState {
  if (!isRecord(value) || value.version !== 1) return structuredClone(EMPTY_STATE);
  const recentProjects = Array.isArray(value.recentProjects)
    ? value.recentProjects
        .map(parseRecentProject)
        .filter((project): project is RecentProject => project !== null)
        .slice(0, 12)
    : [];
  const mediaPoolOpenByProject: Record<string, boolean> = {};
  if (isRecord(value.mediaPoolOpenByProject)) {
    for (const [directory, open] of Object.entries(value.mediaPoolOpenByProject)) {
      if (typeof open === "boolean") mediaPoolOpenByProject[directory] = open;
    }
  }
  const inspectorOpenByProject: Record<string, boolean> = {};
  if (isRecord(value.inspectorOpenByProject)) {
    for (const [directory, open] of Object.entries(value.inspectorOpenByProject)) {
      if (typeof open === "boolean") inspectorOpenByProject[directory] = open;
    }
  }
  const notesOpenByProject: Record<string, boolean> = {};
  if (isRecord(value.notesOpenByProject)) {
    for (const [directory, open] of Object.entries(value.notesOpenByProject)) {
      if (typeof open === "boolean") notesOpenByProject[directory] = open;
    }
  }
  const editorLayoutsByProject: Record<string, EditorLayoutState> = {};
  if (isRecord(value.editorLayoutsByProject)) {
    for (const [directory, layout] of Object.entries(value.editorLayoutsByProject)) {
      const parsed = parseEditorLayoutState(layout);
      if (parsed) editorLayoutsByProject[directory] = parsed;
    }
  }
  return {
    version: 1,
    recentProjects,
    mediaPoolOpenByProject,
    inspectorOpenByProject,
    notesOpenByProject,
    editorLayoutsByProject,
  };
}

export class DesktopAppStateStore {
  #accounts: Record<string, DesktopAppState> = {};
  #accountId: string | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.accounts)) return;
      for (const [accountId, state] of Object.entries(parsed.accounts)) {
        if (accountId) this.#accounts[accountId] = parseState(state);
      }
    } catch {
      this.#accounts = {};
    }
  }

  setAccount(accountId: string | null): void {
    this.#accountId = accountId;
  }

  snapshot(): DesktopAppState {
    return structuredClone(this.#current());
  }

  hasRecent(directory: string): boolean {
    return this.#current().recentProjects.some((project) => project.directory === directory);
  }

  async rememberProject(project: RecentProject): Promise<void> {
    const state = this.#requireCurrent();
    state.recentProjects = [
      project,
      ...state.recentProjects.filter((recent) => recent.directory !== project.directory),
    ].slice(0, 12);
    await this.#queueSave();
  }

  async forgetProject(directory: string): Promise<void> {
    const state = this.#requireCurrent();
    state.recentProjects = state.recentProjects.filter(
      (project) => project.directory !== directory,
    );
    delete state.mediaPoolOpenByProject[directory];
    delete state.inspectorOpenByProject[directory];
    delete state.notesOpenByProject[directory];
    delete state.editorLayoutsByProject[directory];
    await this.#queueSave();
  }

  async setMediaPoolOpen(directory: string, open: boolean): Promise<void> {
    this.#requireCurrent().mediaPoolOpenByProject[directory] = open;
    await this.#queueSave();
  }

  async setInspectorOpen(directory: string, open: boolean): Promise<void> {
    this.#requireCurrent().inspectorOpenByProject[directory] = open;
    await this.#queueSave();
  }

  async setNotesOpen(directory: string, open: boolean): Promise<void> {
    this.#requireCurrent().notesOpenByProject[directory] = open;
    await this.#queueSave();
  }

  async setEditorLayout(directory: string, layout: EditorLayoutState): Promise<void> {
    this.#requireCurrent().editorLayoutsByProject[directory] = structuredClone(layout);
    await this.#queueSave();
  }

  async #queueSave(): Promise<void> {
    const contents = `${JSON.stringify({ version: 2, accounts: this.#accounts }, null, 2)}\n`;
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

  #current(): DesktopAppState {
    if (!this.#accountId) return structuredClone(EMPTY_STATE);
    return (this.#accounts[this.#accountId] ??= structuredClone(EMPTY_STATE));
  }

  #requireCurrent(): DesktopAppState {
    if (!this.#accountId) throw new Error("Sign in before changing local project state");
    return (this.#accounts[this.#accountId] ??= structuredClone(EMPTY_STATE));
  }
}

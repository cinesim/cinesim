import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CUT_LAYOUT_LIMITS,
  DEFAULT_CUT_LAYOUT,
  DEFAULT_EDITOR_LAYOUT,
  EDITOR_LAYOUT_LIMITS,
} from "../../shared/api";
import type {
  CutLayoutState,
  DesktopAppState,
  EditorLayoutState,
  RecentProject,
} from "../../shared/api";

const EMPTY_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  mediaPoolOpenByProject: {},
  inspectorOpenByProject: {},
  notesOpenByProject: {},
  editorLayoutsByProject: {},
  cutLayoutsByProject: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecentProject(value: unknown): RecentProject | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.directory !== "string" ||
    (value.kind !== "local" && value.kind !== "cloud")
  )
    return null;
  return { name: value.name, directory: value.directory, kind: value.kind };
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

export function parseCutLayoutState(value: unknown): CutLayoutState | null {
  if (!isRecord(value)) return null;
  const result = { ...DEFAULT_CUT_LAYOUT };
  for (const field of ["rightColumnWidth", "viewerHeight", "timelineHeight"] as const) {
    const size = value[field];
    const limits = CUT_LAYOUT_LIMITS[field];
    if (
      typeof size !== "number" ||
      !Number.isFinite(size) ||
      size < limits.min ||
      size > limits.max
    )
      return null;
    result[field] = size;
  }
  return result;
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
  const cutLayoutsByProject: Record<string, CutLayoutState> = {};
  if (isRecord(value.cutLayoutsByProject)) {
    for (const [directory, layout] of Object.entries(value.cutLayoutsByProject)) {
      const parsed = parseCutLayoutState(layout);
      if (parsed) cutLayoutsByProject[directory] = parsed;
    }
  }
  return {
    version: 1,
    recentProjects,
    mediaPoolOpenByProject,
    inspectorOpenByProject,
    notesOpenByProject,
    editorLayoutsByProject,
    cutLayoutsByProject,
  };
}

export class DesktopAppStateStore {
  #local: DesktopAppState = structuredClone(EMPTY_STATE);
  #accounts: Record<string, DesktopAppState> = {};
  #accountId: string | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (
        !isRecord(parsed) ||
        parsed.version !== 3 ||
        !isRecord(parsed.local) ||
        !isRecord(parsed.accounts)
      )
        return;
      this.#local = parseState(parsed.local);
      for (const [accountId, state] of Object.entries(parsed.accounts)) {
        if (accountId) this.#accounts[accountId] = parseState(state);
      }
    } catch {
      this.#local = structuredClone(EMPTY_STATE);
      this.#accounts = {};
    }
  }

  setAccount(accountId: string | null): void {
    this.#accountId = accountId;
  }

  snapshot(): DesktopAppState {
    const cloud = this.#currentCloud(false);
    return structuredClone({
      version: 1,
      recentProjects: [...(cloud?.recentProjects ?? []), ...this.#local.recentProjects],
      mediaPoolOpenByProject: {
        ...this.#local.mediaPoolOpenByProject,
        ...cloud?.mediaPoolOpenByProject,
      },
      inspectorOpenByProject: {
        ...this.#local.inspectorOpenByProject,
        ...cloud?.inspectorOpenByProject,
      },
      notesOpenByProject: {
        ...this.#local.notesOpenByProject,
        ...cloud?.notesOpenByProject,
      },
      editorLayoutsByProject: {
        ...this.#local.editorLayoutsByProject,
        ...cloud?.editorLayoutsByProject,
      },
      cutLayoutsByProject: {
        ...this.#local.cutLayoutsByProject,
        ...cloud?.cutLayoutsByProject,
      },
    });
  }

  hasRecent(directory: string, kind?: RecentProject["kind"]): boolean {
    return this.snapshot().recentProjects.some(
      (project) => project.directory === directory && (!kind || project.kind === kind),
    );
  }

  async rememberProject(project: RecentProject): Promise<void> {
    const state = project.kind === "local" ? this.#local : this.#requireCloud();
    state.recentProjects = [
      project,
      ...state.recentProjects.filter((recent) => recent.directory !== project.directory),
    ].slice(0, 12);
    await this.#queueSave();
  }

  async forgetProject(directory: string): Promise<void> {
    const state = this.#stateForDirectory(directory);
    state.recentProjects = state.recentProjects.filter(
      (project) => project.directory !== directory,
    );
    delete state.mediaPoolOpenByProject[directory];
    delete state.inspectorOpenByProject[directory];
    delete state.notesOpenByProject[directory];
    delete state.editorLayoutsByProject[directory];
    delete state.cutLayoutsByProject[directory];
    await this.#queueSave();
  }

  async setMediaPoolOpen(directory: string, open: boolean): Promise<void> {
    this.#stateForDirectory(directory).mediaPoolOpenByProject[directory] = open;
    await this.#queueSave();
  }

  async setInspectorOpen(directory: string, open: boolean): Promise<void> {
    this.#stateForDirectory(directory).inspectorOpenByProject[directory] = open;
    await this.#queueSave();
  }

  async setNotesOpen(directory: string, open: boolean): Promise<void> {
    this.#stateForDirectory(directory).notesOpenByProject[directory] = open;
    await this.#queueSave();
  }

  async setEditorLayout(directory: string, layout: EditorLayoutState): Promise<void> {
    this.#stateForDirectory(directory).editorLayoutsByProject[directory] = structuredClone(layout);
    await this.#queueSave();
  }

  async setCutLayout(directory: string, layout: CutLayoutState): Promise<void> {
    this.#stateForDirectory(directory).cutLayoutsByProject[directory] = structuredClone(layout);
    await this.#queueSave();
  }

  async #queueSave(): Promise<void> {
    const contents = `${JSON.stringify(
      { version: 3, local: this.#local, accounts: this.#accounts },
      null,
      2,
    )}\n`;
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

  #currentCloud(create: boolean): DesktopAppState | null {
    if (!this.#accountId) return null;
    if (create) return (this.#accounts[this.#accountId] ??= structuredClone(EMPTY_STATE));
    return this.#accounts[this.#accountId] ?? null;
  }

  #requireCloud(): DesktopAppState {
    const state = this.#currentCloud(true);
    if (!state) throw new Error("Sign in before changing cloud project state");
    return state;
  }

  #stateForDirectory(directory: string): DesktopAppState {
    if (this.#local.recentProjects.some((project) => project.directory === directory))
      return this.#local;
    const cloud = this.#currentCloud(false);
    if (cloud?.recentProjects.some((project) => project.directory === directory)) return cloud;
    throw new Error("Project is not in the recent projects list");
  }
}

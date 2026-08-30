import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CUT_LAYOUT_LIMITS,
  DEFAULT_CUT_LAYOUT,
  DEFAULT_EDITOR_LAYOUT,
  DEFAULT_TRANSCRIPTION_SETTINGS,
  EDITOR_LAYOUT_LIMITS,
} from "../../shared/contracts";
import type {
  CutLayoutState,
  DesktopAppState,
  EditorLayoutState,
  RecentProject,
  TranscriptionSettings,
} from "../../shared/contracts";

const EMPTY_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  mediaPoolOpenByProject: {},
  inspectorOpenByProject: {},
  notesOpenByProject: {},
  editorLayoutsByProject: {},
  cutLayoutsByProject: {},
  transcriptionSettings: DEFAULT_TRANSCRIPTION_SETTINGS,
};

interface PersistedDesktopState {
  local: unknown;
  accounts: Record<string, unknown>;
}

interface NumericLimits {
  min: number;
  max: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyState(): DesktopAppState {
  return structuredClone(EMPTY_STATE);
}

function isFiniteSize(value: unknown, limits: NumericLimits): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= limits.min &&
    value <= limits.max
  );
}

function isProjectKind(value: unknown): value is RecentProject["kind"] {
  return value === "local" || value === "cloud";
}

function parseRecentProject(value: unknown): RecentProject | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.directory !== "string" ||
    !isProjectKind(value.kind)
  )
    return null;
  return { name: value.name, directory: value.directory, kind: value.kind };
}

function parseRecentProjects(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) return [];

  const projects: RecentProject[] = [];
  for (const candidate of value) {
    const project = parseRecentProject(candidate);
    if (project) projects.push(project);
    if (projects.length === 12) break;
  }
  return projects;
}

function parseBooleanByProject(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};

  const result: Record<string, boolean> = {};
  for (const [directory, candidate] of Object.entries(value)) {
    if (typeof candidate === "boolean") result[directory] = candidate;
  }
  return result;
}

function parseByProject<T>(
  value: unknown,
  parse: (candidate: unknown) => T | null,
): Record<string, T> {
  if (!isRecord(value)) return {};

  const result: Record<string, T> = {};
  for (const [directory, candidate] of Object.entries(value)) {
    const parsed = parse(candidate);
    if (parsed) result[directory] = parsed;
  }
  return result;
}

export function parseEditorLayoutState(value: unknown): EditorLayoutState | null {
  if (!isRecord(value)) return null;
  const fields = ["mediaPoolWidth", "inspectorWidth", "timelineHeight"] as const;
  for (const field of fields) {
    const size = value[field];
    const limits = EDITOR_LAYOUT_LIMITS[field];
    if (!isFiniteSize(size, limits)) return null;
  }
  const notesWidth = value.notesWidth ?? DEFAULT_EDITOR_LAYOUT.notesWidth;
  if (!isFiniteSize(notesWidth, EDITOR_LAYOUT_LIMITS.notesWidth)) return null;
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
    if (!isFiniteSize(size, limits)) return null;
    result[field] = size;
  }
  return result;
}

export function parseTranscriptionSettings(value: unknown): TranscriptionSettings | null {
  if (
    !isRecord(value) ||
    (value.generation !== "manual" && value.generation !== "automatic") ||
    value.model !== "deepgram/nova-3"
  ) {
    return null;
  }
  return { generation: value.generation, model: value.model };
}

function parseState(value: unknown): DesktopAppState {
  if (!isRecord(value) || value.version !== 1) return emptyState();

  return {
    version: 1,
    recentProjects: parseRecentProjects(value.recentProjects),
    mediaPoolOpenByProject: parseBooleanByProject(value.mediaPoolOpenByProject),
    inspectorOpenByProject: parseBooleanByProject(value.inspectorOpenByProject),
    notesOpenByProject: parseBooleanByProject(value.notesOpenByProject),
    editorLayoutsByProject: parseByProject(value.editorLayoutsByProject, parseEditorLayoutState),
    cutLayoutsByProject: parseByProject(value.cutLayoutsByProject, parseCutLayoutState),
    transcriptionSettings:
      parseTranscriptionSettings(value.transcriptionSettings) ??
      structuredClone(DEFAULT_TRANSCRIPTION_SETTINGS),
  };
}

function parsePersistedDesktopState(value: unknown): PersistedDesktopState | null {
  if (!isRecord(value) || value.version !== 3) return null;
  if (!isRecord(value.local) || !isRecord(value.accounts)) return null;
  return { local: value.local, accounts: value.accounts };
}

export class DesktopAppStateStore {
  #local: DesktopAppState = emptyState();
  #accounts: Record<string, DesktopAppState> = {};
  #accountId: string | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const persisted = parsePersistedDesktopState(
        JSON.parse(await readFile(this.path, "utf8")) as unknown,
      );
      if (!persisted) return;

      this.#local = parseState(persisted.local);
      for (const [accountId, state] of Object.entries(persisted.accounts)) {
        if (accountId) this.#accounts[accountId] = parseState(state);
      }
    } catch {
      this.#local = emptyState();
      this.#accounts = {};
    }
  }

  setAccount(accountId: string | null): void {
    this.#accountId = accountId;
  }

  snapshot(): DesktopAppState {
    const cloud = this.#currentCloud();
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
      transcriptionSettings: cloud?.transcriptionSettings ?? this.#local.transcriptionSettings,
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

  async setTranscriptionSettings(settings: TranscriptionSettings): Promise<void> {
    this.#requireCloud().transcriptionSettings = structuredClone(settings);
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

  #currentCloud(): DesktopAppState | null {
    if (!this.#accountId) return null;
    return this.#accounts[this.#accountId] ?? null;
  }

  #requireCloud(): DesktopAppState {
    if (!this.#accountId) throw new Error("Sign in before changing cloud project state");
    return (this.#accounts[this.#accountId] ??= emptyState());
  }

  #stateForDirectory(directory: string): DesktopAppState {
    if (this.#local.recentProjects.some((project) => project.directory === directory))
      return this.#local;
    const cloud = this.#currentCloud();
    if (cloud?.recentProjects.some((project) => project.directory === directory)) return cloud;
    throw new Error("Project is not in the recent projects list");
  }
}

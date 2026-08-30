import type { EditorCommand } from "../commands/types";
import { applyCommand } from "../commands/apply";
import type { CommandResult } from "../commands/types";
import type { Project } from "../project/types";

interface HistoryEntry {
  before: Project;
  after: Project;
  command: EditorCommand;
  estimatedBytes: number;
}

export interface ProjectHistoryOptions {
  maxEntries?: number;
  maxEstimatedBytes?: number;
}

export interface ProjectHistoryStats {
  undoEntries: number;
  redoEntries: number;
  estimatedBytes: number;
  maxEntries: number;
  maxEstimatedBytes: number;
}

export const DEFAULT_HISTORY_MAX_ENTRIES = 200;
export const DEFAULT_HISTORY_MAX_ESTIMATED_BYTES = 64 * 1024 * 1024;

function valueBytes(value: unknown): number {
  return JSON.stringify(value).length * 2;
}

export class ProjectHistory {
  #project: Project;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #estimatedBytes = 0;
  readonly #maxEntries: number;
  readonly #maxEstimatedBytes: number;

  constructor(project: Project, options: ProjectHistoryOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_HISTORY_MAX_ENTRIES;
    this.#maxEstimatedBytes = options.maxEstimatedBytes ?? DEFAULT_HISTORY_MAX_ESTIMATED_BYTES;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new Error("History maxEntries must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#maxEstimatedBytes) || this.#maxEstimatedBytes < 1) {
      throw new Error("History maxEstimatedBytes must be a positive integer");
    }
    this.#project = structuredClone(project);
  }

  get project(): Project {
    return structuredClone(this.#project);
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get stats(): ProjectHistoryStats {
    return {
      undoEntries: this.#undo.length,
      redoEntries: this.#redo.length,
      estimatedBytes: this.#estimatedBytes,
      maxEntries: this.#maxEntries,
      maxEstimatedBytes: this.#maxEstimatedBytes,
    };
  }

  commit(command: EditorCommand): CommandResult {
    const before = this.project;
    const result = applyCommand(before, command);
    return this.commitApplied(result);
  }

  commitApplied(result: CommandResult): CommandResult {
    const before = this.project;
    this.#project = structuredClone(result.project);
    const after = this.project;
    this.#clearRedo();
    const entry = {
      before,
      after,
      command: result.command,
      estimatedBytes: valueBytes(before) + valueBytes(after) + valueBytes(result.command),
    };
    this.#undo.push(entry);
    this.#estimatedBytes += entry.estimatedBytes;
    this.#enforceBounds();
    return { ...result, project: this.project };
  }

  peekUndo(): Project | null {
    const entry = this.#undo.at(-1);
    return entry ? structuredClone(entry.before) : null;
  }

  peekRedo(): Project | null {
    const entry = this.#redo.at(-1);
    return entry ? structuredClone(entry.after) : null;
  }

  undo(): Project {
    const entry = this.#undo.pop();
    if (!entry) return this.project;
    this.#project = structuredClone(entry.before);
    this.#redo.push(entry);
    return this.project;
  }

  redo(): Project {
    const entry = this.#redo.pop();
    if (!entry) return this.project;
    this.#project = structuredClone(entry.after);
    this.#undo.push(entry);
    return this.project;
  }

  #clearRedo(): void {
    for (const entry of this.#redo) this.#estimatedBytes -= entry.estimatedBytes;
    this.#redo = [];
  }

  #enforceBounds(): void {
    while (
      this.#undo.length > 1 &&
      (this.#undo.length + this.#redo.length > this.#maxEntries ||
        this.#estimatedBytes > this.#maxEstimatedBytes)
    ) {
      const discarded = this.#undo.shift();
      if (discarded) this.#estimatedBytes -= discarded.estimatedBytes;
    }
  }
}

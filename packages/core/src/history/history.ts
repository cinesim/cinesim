import type { EditorCommand } from "../commands/types";
import { applyCommand } from "../commands/apply";
import type { CommandResult } from "../commands/types";
import type { Project } from "../project/types";

interface HistoryEntry {
  before: Project;
  after: Project;
  command: EditorCommand;
}

export class ProjectHistory {
  #project: Project;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];

  constructor(project: Project) {
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

  commit(command: EditorCommand): CommandResult {
    const before = this.project;
    const result = applyCommand(before, command);
    return this.commitApplied(result);
  }

  commitApplied(result: CommandResult): CommandResult {
    const before = this.project;
    this.#project = structuredClone(result.project);
    this.#undo.push({ before, after: this.project, command: result.command });
    this.#redo = [];
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
}

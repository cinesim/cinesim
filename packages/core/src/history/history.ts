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
    this.#project = result.project;
    this.#undo.push({ before, after: this.project, command });
    this.#redo = [];
    return { ...result, project: this.project };
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

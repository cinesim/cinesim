import type { EditorCommand, Project, ProjectSettings } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { CanonicalProjectRepository } from "@cinesim/project-io";
import { dispatchCommand } from "@cinesim/protocol";

const log = createCinesimLogger({ service: "commands" });

export class DiskProjectStore {
  readonly directory: string;
  project!: Project;
  settings!: ProjectSettings;
  #generation: string | null = null;
  #repository: CanonicalProjectRepository | null = null;

  constructor(directory = process.env.CINESIM_PROJECT || process.cwd()) {
    this.directory = directory;
  }

  async load(): Promise<this> {
    this.#repository = await CanonicalProjectRepository.open(this.directory);
    const snapshot = await this.#repository.load();
    this.project = snapshot.project;
    this.settings = snapshot.settings;
    this.#generation = snapshot.generation;
    return this;
  }

  async save(): Promise<void> {
    this.#generation = await this.#requireRepository().commit({
      project: this.project,
      settings: this.settings,
      expectedGeneration: this.#generation,
    });
  }

  async execute(command: EditorCommand) {
    const operationId = crypto.randomUUID();
    const startedAt = Date.now();
    log.info({ operationId, operation: command.type }, "command started");
    try {
      const result = dispatchCommand(this.project, command);
      if (!result.ok) {
        const error = new Error(`${result.error.code}: ${result.error.message}`);
        (error as Error & { code: string }).code = result.error.code;
        throw error;
      }
      const generation = await this.#requireRepository().commit({
        project: result.value.project,
        settings: this.settings,
        expectedGeneration: this.#generation,
      });
      this.project = result.value.project;
      this.#generation = generation;
      log.info(
        {
          operationId,
          operation: command.type,
          durationMs: Date.now() - startedAt,
          changedIds: result.value.changedIds,
          createdIds: result.value.createdIds,
        },
        "command completed",
      );
      return result.value;
    } catch (error) {
      log.error(
        { err: error, operationId, operation: command.type, durationMs: Date.now() - startedAt },
        "command failed",
      );
      throw error;
    }
  }

  #requireRepository(): CanonicalProjectRepository {
    if (!this.#repository) throw new Error("Project store must be loaded before use");
    return this.#repository;
  }
}

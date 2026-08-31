import { irProgramToProjectProjection, type Project, type ProjectSettings } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import type { IrEditMap, IrProgram } from "@cinesim/ir";
import { SourceCommandService } from "@cinesim/project-io";
import { editorCommandSchema } from "@cinesim/protocol";

const log = createCinesimLogger({ service: "commands" });

/** CLI adapter over the same source-backed command service used by desktop and MCP. */
export class DiskProjectStore {
  readonly directory: string;
  project!: Project;
  program!: IrProgram;
  editMap!: IrEditMap;
  settings!: ProjectSettings;
  #service: SourceCommandService | null = null;

  constructor(directory = process.env.CINESIM_PROJECT || process.cwd()) {
    this.directory = directory;
  }

  async load(): Promise<this> {
    this.#service = await SourceCommandService.open(this.directory);
    this.#projectFromSnapshot();
    return this;
  }

  async save(): Promise<void> {
    await this.#requireService().refresh();
    this.#projectFromSnapshot();
  }

  async execute(input: unknown) {
    const command = editorCommandSchema.parse(input);
    const operationId = crypto.randomUUID();
    const startedAt = Date.now();
    log.info({ operationId, operation: command.type }, "command started");
    try {
      const result = await this.#requireService().execute(command);
      this.#projectFromSnapshot();
      log.info(
        {
          operationId,
          operation: command.type,
          durationMs: Date.now() - startedAt,
          changedIds: result.changedIds,
          createdIds: result.createdIds,
        },
        "command completed",
      );
      return result;
    } catch (error) {
      log.error(
        {
          err: error,
          operationId,
          operation: command.type,
          durationMs: Date.now() - startedAt,
        },
        "command failed",
      );
      throw error;
    }
  }

  #projectFromSnapshot(): void {
    const snapshot = this.#requireService().snapshot;
    this.settings = snapshot.manifest.settings;
    this.program = structuredClone(snapshot.compilation.ir);
    this.editMap = structuredClone(snapshot.compilation.sourceMap);
    this.project = irProgramToProjectProjection(snapshot.compilation.ir, {
      name: snapshot.manifest.project.name,
      assets: snapshot.manifest.assets,
      ...(snapshot.manifest.project.cloudProjectId === undefined
        ? {}
        : {
            cloudProjectId: snapshot.manifest.project.cloudProjectId as Project["cloudProjectId"],
          }),
    });
  }

  #requireService(): SourceCommandService {
    if (!this.#service) throw new Error("Project store must be loaded before use");
    return this.#service;
  }
}

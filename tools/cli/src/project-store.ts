import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  joinProjectFiles,
  PROJECT_FILES,
  settingsFromToml,
  settingsToToml,
  splitProjectFiles,
  stableJson,
} from "@cinesim/core";
import type { EditorCommand, Project, ProjectSettings } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { dispatchCommand } from "@cinesim/protocol";

const log = createCinesimLogger({ service: "commands" });

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

export class DiskProjectStore {
  readonly directory: string;
  project!: Project;
  settings!: ProjectSettings;

  constructor(directory = process.env.CINESIM_PROJECT || process.cwd()) {
    this.directory = directory;
  }

  async load(): Promise<this> {
    const [manifest, assets, timeline, settings] = await Promise.all([
      json(join(this.directory, PROJECT_FILES.manifest)),
      json(join(this.directory, PROJECT_FILES.assets)),
      json(join(this.directory, PROJECT_FILES.timeline)),
      readFile(join(this.directory, PROJECT_FILES.settings), "utf8"),
    ]);
    this.project = joinProjectFiles(manifest, assets, timeline);
    this.settings = settingsFromToml(settings);
    return this;
  }

  async save(): Promise<void> {
    const files = splitProjectFiles(this.project);
    await Promise.all([
      atomicWrite(join(this.directory, PROJECT_FILES.manifest), stableJson(files.manifest)),
      atomicWrite(join(this.directory, PROJECT_FILES.assets), stableJson(files.assets)),
      atomicWrite(join(this.directory, PROJECT_FILES.timeline), stableJson(files.timeline)),
      atomicWrite(join(this.directory, PROJECT_FILES.settings), settingsToToml(this.settings)),
    ]);
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
      this.project = result.value.project;
      await this.save();
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
}

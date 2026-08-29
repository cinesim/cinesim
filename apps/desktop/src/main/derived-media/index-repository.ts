import { readFile, rename, writeFile } from "node:fs/promises";
import type { ProjectPaths } from "@cinesim/project-io";
import {
  DERIVED_GENERATOR_VERSION,
  emptyIndex,
  emptyStorage,
  INDEX_FILE,
  MAX_DECISION_EVENTS,
} from "./model";
import type { PersistedIndex } from "./model";

export class DerivedIndexRepository {
  #persistQueue: Promise<void> = Promise.resolve();

  async read(paths: ProjectPaths): Promise<PersistedIndex> {
    const path = await paths.assertSafeDerivedFile(INDEX_FILE);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as PersistedIndex;
      if (value.version !== 1 || value.generatorVersion !== DERIVED_GENERATOR_VERSION)
        return emptyIndex();
      value.decisionLog = Array.isArray(value.decisionLog)
        ? value.decisionLog.slice(-MAX_DECISION_EVENTS)
        : [];
      value.storage = { ...emptyStorage(), ...value.storage };
      return value;
    } catch {
      return emptyIndex();
    }
  }

  async write(paths: ProjectPaths, index: PersistedIndex): Promise<void> {
    const path = await paths.assertSafeDerivedFile(INDEX_FILE);
    const contents = `${JSON.stringify(index, null, 2)}\n`;
    const operation = async () => {
      const tempPath = `${path}.tmp`;
      await writeFile(tempPath, contents, "utf8");
      await rename(tempPath, path);
    };
    const result = this.#persistQueue.catch(() => undefined).then(operation);
    this.#persistQueue = result;
    await result;
  }
}

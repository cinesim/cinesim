import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

  async read(directory: string): Promise<PersistedIndex> {
    try {
      const value = JSON.parse(
        await readFile(join(directory, INDEX_FILE), "utf8"),
      ) as PersistedIndex;
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

  async write(directory: string, index: PersistedIndex): Promise<void> {
    const path = join(directory, INDEX_FILE);
    const contents = `${JSON.stringify(index, null, 2)}\n`;
    const operation = async () => {
      const tempPath = `${path}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tempPath, contents, "utf8");
      await rename(tempPath, path);
    };
    const result = this.#persistQueue.catch(() => undefined).then(operation);
    this.#persistQueue = result;
    await result;
  }
}

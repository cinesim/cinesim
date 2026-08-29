import { join } from "node:path";
import type { ProjectPaths } from "@cinesim/project-io";

export class DerivedOperationQueue {
  #pending: Promise<unknown> = Promise.resolve();

  serialize<T>(
    paths: ProjectPaths | null,
    folders: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = this.#pending
      .catch(() => undefined)
      .then(async () => {
        if (paths)
          await paths.verifyDirectories([
            ".video",
            ...folders.map((folder) => join(".video", folder)),
          ]);
        return operation();
      });
    this.#pending = result;
    return result;
  }
}

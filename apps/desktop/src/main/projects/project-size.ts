import { stat } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_FILES } from "@cinesim/core";

/** Returns the on-disk size of canonical project files, excluding disposable .video output. */
export async function canonicalProjectSizeBytes(directory: string): Promise<number> {
  const fileStats = await Promise.all(
    Object.values(PROJECT_FILES).map((relativePath) => stat(join(directory, relativePath))),
  );

  return fileStats.reduce((total, file) => total + file.size, 0);
}

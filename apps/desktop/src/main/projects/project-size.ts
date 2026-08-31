import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Returns source-format canonical bytes while excluding all disposable .video output. */
export async function canonicalProjectSizeBytes(directory: string): Promise<number> {
  let total = 0;
  const visit = async (current: string, relative = ""): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".video" || entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      if ((await lstat(path)).isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path, nextRelative);
        continue;
      }
      if (
        nextRelative === "cinesim.toml" ||
        nextRelative === "AGENTS.md" ||
        nextRelative === ".gitignore" ||
        /\.(?:js|jsx)$/u.test(nextRelative)
      ) {
        total += (await stat(path)).size;
      }
    }
  };
  await visit(directory);
  return total;
}

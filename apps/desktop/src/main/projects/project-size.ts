import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const EXCLUDED_DIRECTORIES = new Set([".video", ".git", "node_modules"]);

function isCanonicalFile(relative: string): boolean {
  return (
    relative === "cinesim.toml" ||
    relative === "assets.toml" ||
    relative === "AGENTS.md" ||
    relative === ".gitignore" ||
    /\.(?:js|jsx)$/u.test(relative)
  );
}

async function canonicalEntrySize(
  current: string,
  relative: string,
  entry: Dirent,
): Promise<number> {
  if (EXCLUDED_DIRECTORIES.has(entry.name)) return 0;
  const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
  const entryPath = join(current, entry.name);
  if ((await lstat(entryPath)).isSymbolicLink()) return 0;
  if (entry.isDirectory()) return canonicalDirectorySize(entryPath, nextRelative);
  return isCanonicalFile(nextRelative) ? (await stat(entryPath)).size : 0;
}

async function canonicalDirectorySize(current: string, relative = ""): Promise<number> {
  const entries = await readdir(current, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map((entry) => canonicalEntrySize(current, relative, entry)),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

/** Returns source-format canonical bytes while excluding all disposable .video output. */
export async function canonicalProjectSizeBytes(directory: string): Promise<number> {
  return canonicalDirectorySize(directory);
}

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanonicalProjectRepository } from "@cinesim/project-io";

const PROJECT_DIRECTORY_COLLISION_LIMIT = 10_000;
const DERIVED_FOLDERS = [
  "cache",
  "proxies",
  "originals",
  "thumbnails",
  "waveforms",
  "filmstrips",
  "frames",
  "runtime",
  "transcripts",
] as const;

const PROJECT_AGENTS = `# Project creative direction

This is a Cinesim video editing project.

- Prefer the Cinesim CLI or MCP tools for timeline edits.
- Canonical state is \`cinesim.json\` and \`.cinesim/\`.
- Human-readable settings are in \`.cinesim/settings.toml\`.
- \`.video/\` contains generated caches, optional downloaded originals, proxies, perception
  artifacts, and runtime files.
- Derived files may be deleted and regenerated. Do not edit them manually.
- Cinesim may offload originals under the signed-in account's storage policy. Agents must not move
  or modify source media directly.

Add creative direction below this line.
`;

const PROJECT_GITIGNORE = `.video/
.DS_Store
`;

async function writeIfMissing(path: string, contents: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path, contents, "utf8");
  }
}

export function projectDirectorySlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "untitled-project"
  );
}

export async function createAvailableProjectDirectory(
  parentDirectory: string,
  slug: string,
): Promise<string> {
  for (let ordinal = 1; ordinal <= PROJECT_DIRECTORY_COLLISION_LIMIT; ordinal += 1) {
    const directory = join(parentDirectory, ordinal === 1 ? slug : `${slug}-${ordinal}`);
    try {
      await mkdir(directory, { recursive: false });
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(
    `Could not create project folder: ${PROJECT_DIRECTORY_COLLISION_LIMIT} names are already in use`,
  );
}

export async function ensureProjectLayout(repository: CanonicalProjectRepository): Promise<void> {
  await repository.paths.ensureLayout(DERIVED_FOLDERS);
  await Promise.all([
    repository.paths
      .assertSafeFile("AGENTS.md")
      .then((path) => writeIfMissing(path, PROJECT_AGENTS)),
    repository.paths
      .assertSafeFile(".gitignore")
      .then((path) => writeIfMissing(path, PROJECT_GITIGNORE)),
  ]);
}

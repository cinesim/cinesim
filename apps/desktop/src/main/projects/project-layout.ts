import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  mergeClaudeInstructions,
  mergeClaudeMcpConfig,
  mergeCodexMcpConfig,
  mergeProjectAgents,
  projectCustomInstructions,
  renderProjectAgents,
  renderManagedProjectGuidance,
  type SourceProjectRepository,
} from "@cinesim/project-io";
import type { DesktopProjectGuidance } from "../../shared/contracts";

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

async function mergeManagedFile(
  path: string,
  merge: (existing: string | null) => string,
): Promise<void> {
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  const next = merge(existing);
  if (existing === next) return;
  const temporary = `${path}.cinesim.tmp`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, path);
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

export async function ensureProjectLayout(
  repository: SourceProjectRepository,
  defaultCustomInstructions = "",
): Promise<void> {
  await repository.paths.ensureLayout(DERIVED_FOLDERS);
  await repository.paths.ensureDirectory(".codex");
  await Promise.all([
    repository.paths
      .assertSafeFile("AGENTS.md")
      .then((path) =>
        mergeManagedFile(path, (existing) =>
          mergeProjectAgents(existing, defaultCustomInstructions),
        ),
      ),
    repository.paths
      .assertSafeFile("CLAUDE.md")
      .then((path) => mergeManagedFile(path, mergeClaudeInstructions)),
    repository.paths
      .assertSafeFile(".mcp.json")
      .then((path) => mergeManagedFile(path, mergeClaudeMcpConfig)),
    repository.paths
      .assertSafeFile(".codex/config.toml")
      .then((path) => mergeManagedFile(path, mergeCodexMcpConfig)),
    repository.paths
      .assertSafeFile(".gitignore")
      .then((path) => writeIfMissing(path, PROJECT_GITIGNORE)),
  ]);
}

export async function projectGuidance(
  repository: SourceProjectRepository | null,
  defaultCustomInstructions: string,
): Promise<DesktopProjectGuidance> {
  let currentProjectInstructions: string | null = null;
  if (repository) {
    const path = await repository.paths.assertSafeFile("AGENTS.md");
    const source = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    currentProjectInstructions =
      source === null ? defaultCustomInstructions : projectCustomInstructions(source);
  }
  return {
    managedBlock: renderManagedProjectGuidance(),
    defaultCustomInstructions,
    projectCustomInstructions: currentProjectInstructions,
  };
}

export async function writeProjectGuidance(
  repository: SourceProjectRepository,
  customInstructions: string,
  defaultCustomInstructions: string,
): Promise<DesktopProjectGuidance> {
  const path = await repository.paths.assertSafeFile("AGENTS.md");
  await mergeManagedFile(path, () => renderProjectAgents(customInstructions));
  return projectGuidance(repository, defaultCustomInstructions);
}

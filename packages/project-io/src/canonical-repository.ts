import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  joinProjectFiles,
  PROJECT_FILES,
  settingsFromToml,
  settingsToToml,
  splitProjectFiles,
  stableJson,
} from "@cinesim/core";
import type { Project, ProjectSettings } from "@cinesim/core";
import type { ProjectFileSystem } from "./file-system";
import { nodeProjectFileSystem } from "./file-system";
import { ProjectPaths } from "./project-paths";

const CANONICAL_RELATIVE_PATHS = [
  PROJECT_FILES.manifest,
  PROJECT_FILES.assets,
  PROJECT_FILES.timeline,
  PROJECT_FILES.settings,
] as const;
const JOURNAL_PATH = ".cinesim/canonical-transaction.json";
const LOCK_DIRECTORY = ".cinesim/canonical-write.lock";
const LOCK_OWNER = `${LOCK_DIRECTORY}/owner.json`;
const TEMP_PREFIX = ".cinesim-tx-";

type CanonicalRelativePath = (typeof CANONICAL_RELATIVE_PATHS)[number];
type CanonicalContents = Record<CanonicalRelativePath, string | null>;

interface TransactionJournal {
  version: 1;
  transactionId: string;
  previous: CanonicalContents;
  next: Record<CanonicalRelativePath, string>;
}

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface CanonicalProjectSnapshot {
  project: Project;
  settings: ProjectSettings;
  generation: string;
}

export interface CanonicalCommitInput {
  project: Project;
  settings: ProjectSettings;
  expectedGeneration: string | null;
}

export interface CanonicalRepositoryOptions {
  fileSystem?: ProjectFileSystem;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export class CanonicalWriteConflictError extends Error {
  readonly code = "CANONICAL_WRITE_CONFLICT";

  constructor(expected: string | null, actual: string | null) {
    super(
      `Canonical project generation changed (expected ${expected ?? "empty"}, found ${actual ?? "empty"})`,
    );
    this.name = "CanonicalWriteConflictError";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function isCanonicalContents(value: unknown, nullable: boolean): value is CanonicalContents {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return CANONICAL_RELATIVE_PATHS.every(
    (path) => typeof record[path] === "string" || (nullable && record[path] === null),
  );
}

function parseJournal(source: string): TransactionJournal {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid canonical transaction journal");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.transactionId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(record.transactionId) ||
    !isCanonicalContents(record.previous, true) ||
    !isCanonicalContents(record.next, false)
  ) {
    throw new Error("Invalid canonical transaction journal");
  }
  return value as TransactionJournal;
}

function serialize(
  project: Project,
  settings: ProjectSettings,
): Record<CanonicalRelativePath, string> {
  const files = splitProjectFiles(project);
  const contents = {
    [PROJECT_FILES.manifest]: stableJson(files.manifest),
    [PROJECT_FILES.assets]: stableJson(files.assets),
    [PROJECT_FILES.timeline]: stableJson(files.timeline),
    [PROJECT_FILES.settings]: settingsToToml(settings),
  };
  joinProjectFiles(
    JSON.parse(contents[PROJECT_FILES.manifest]) as unknown,
    JSON.parse(contents[PROJECT_FILES.assets]) as unknown,
    JSON.parse(contents[PROJECT_FILES.timeline]) as unknown,
  );
  settingsFromToml(contents[PROJECT_FILES.settings]);
  return contents;
}

function generationOf(contents: CanonicalContents): string | null {
  if (CANONICAL_RELATIVE_PATHS.every((path) => contents[path] === null)) return null;
  if (CANONICAL_RELATIVE_PATHS.some((path) => contents[path] === null))
    throw new Error("Canonical project files are incomplete");
  const hash = createHash("sha256");
  for (const path of CANONICAL_RELATIVE_PATHS) {
    hash.update(path);
    hash.update("\0");
    hash.update(contents[path]!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** @internal Format-v1 reader/writer retained only for migration and migration fixtures. */
export class CanonicalProjectRepository {
  readonly paths: ProjectPaths;
  readonly #fileSystem: ProjectFileSystem;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #now: () => number;
  readonly #isProcessAlive: (pid: number) => boolean;

  private constructor(paths: ProjectPaths, options: CanonicalRepositoryOptions) {
    this.paths = paths;
    this.#fileSystem = options.fileSystem ?? nodeProjectFileSystem;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.#staleLockMs = options.staleLockMs ?? 300_000;
    this.#now = options.now ?? Date.now;
    this.#isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  static async open(
    directory: string,
    options: CanonicalRepositoryOptions = {},
  ): Promise<CanonicalProjectRepository> {
    const fileSystem = options.fileSystem ?? nodeProjectFileSystem;
    const paths = await ProjectPaths.open(directory, fileSystem);
    await paths.ensureDirectory(".cinesim");
    return new CanonicalProjectRepository(paths, options);
  }

  async load(): Promise<CanonicalProjectSnapshot> {
    return this.#withLock(async () => {
      await this.#recover();
      const contents = await this.#readContents();
      const generation = generationOf(contents);
      if (!generation) throw new Error("Canonical project files are missing");
      return {
        project: joinProjectFiles(
          JSON.parse(contents[PROJECT_FILES.manifest]!) as unknown,
          JSON.parse(contents[PROJECT_FILES.assets]!) as unknown,
          JSON.parse(contents[PROJECT_FILES.timeline]!) as unknown,
        ),
        settings: settingsFromToml(contents[PROJECT_FILES.settings]!),
        generation,
      };
    });
  }

  async commit(input: CanonicalCommitInput): Promise<string> {
    const next = serialize(input.project, input.settings);
    const nextGeneration = generationOf(next)!;
    return this.#withLock(async () => {
      await this.#recover();
      const previous = await this.#readContents();
      const actualGeneration = generationOf(previous);
      if (actualGeneration !== input.expectedGeneration)
        throw new CanonicalWriteConflictError(input.expectedGeneration, actualGeneration);
      if (actualGeneration === nextGeneration) return nextGeneration;

      const transactionId = randomUUID();
      const journal: TransactionJournal = { version: 1, transactionId, previous, next };
      const staged = new Map<CanonicalRelativePath, string>();
      try {
        for (const path of CANONICAL_RELATIVE_PATHS) {
          const target = await this.paths.assertSafeFile(path);
          const temporary = join(
            dirname(target),
            `${TEMP_PREFIX}${transactionId}-${basename(path)}.tmp`,
          );
          await this.#writeSynced(temporary, next[path]);
          staged.set(path, temporary);
        }
        await this.#atomicWriteJournal(stableJson(journal), transactionId);
        for (const path of CANONICAL_RELATIVE_PATHS) {
          await this.#fileSystem.rename(staged.get(path)!, this.paths.projectFile(path));
        }
        await this.#syncDirectory(this.paths.root);
        await this.#syncDirectory(this.paths.legacyCanonical(".cinesim"));
        const published = await this.#readContents();
        if (generationOf(published) !== nextGeneration)
          throw new Error("Canonical transaction verification failed");
        await this.#fileSystem.rm(this.paths.legacyCanonical(JOURNAL_PATH));
        await this.#syncDirectory(this.paths.legacyCanonical(".cinesim"));
        return nextGeneration;
      } catch (error) {
        try {
          await this.#recover();
          if (generationOf(await this.#readContents()) === nextGeneration) return nextGeneration;
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Canonical transaction and recovery failed",
          );
        }
        throw error;
      } finally {
        await Promise.all(
          [...staged.values()].map((path) =>
            this.#fileSystem.rm(path, { force: true }).catch(() => undefined),
          ),
        );
      }
    });
  }

  async #readContents(): Promise<CanonicalContents> {
    const entries = await Promise.all(
      CANONICAL_RELATIVE_PATHS.map(async (relativePath) => {
        const path = await this.paths.assertSafeFile(relativePath);
        const contents = await this.#fileSystem.readFile(path, "utf8").catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
        return [relativePath, contents] as const;
      }),
    );
    return Object.fromEntries(entries) as CanonicalContents;
  }

  async #recover(): Promise<void> {
    const journalPath = await this.paths.assertSafeFile(JOURNAL_PATH);
    const source = await this.#fileSystem.readFile(journalPath, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!source) {
      await this.#removeOrphanTemps();
      return;
    }
    const journal = parseJournal(source);
    const current = await this.#readContents();
    const allNext = CANONICAL_RELATIVE_PATHS.every((path) => current[path] === journal.next[path]);
    if (!allNext) {
      for (const relativePath of CANONICAL_RELATIVE_PATHS) {
        const target = await this.paths.assertSafeFile(relativePath);
        const previous = journal.previous[relativePath];
        if (previous === null) {
          await this.#fileSystem.rm(target, { force: true });
          continue;
        }
        const temporary = join(
          dirname(target),
          `${TEMP_PREFIX}${journal.transactionId}-rollback-${basename(relativePath)}.tmp`,
        );
        await this.#writeSynced(temporary, previous);
        await this.#fileSystem.rename(temporary, target);
      }
      await this.#syncDirectory(this.paths.root);
      await this.#syncDirectory(this.paths.legacyCanonical(".cinesim"));
    }
    await this.#fileSystem.rm(journalPath);
    await this.#removeOrphanTemps();
    await this.#syncDirectory(this.paths.legacyCanonical(".cinesim"));
  }

  async #atomicWriteJournal(contents: string, transactionId: string): Promise<void> {
    const journalPath = await this.paths.assertSafeFile(JOURNAL_PATH);
    const temporary = join(dirname(journalPath), `${TEMP_PREFIX}${transactionId}-journal.tmp`);
    await this.#writeSynced(temporary, contents);
    await this.#fileSystem.rename(temporary, journalPath);
    await this.#syncDirectory(dirname(journalPath));
  }

  async #writeSynced(path: string, contents: string): Promise<void> {
    await this.#fileSystem.writeFile(path, contents, { encoding: "utf8", flag: "wx" });
    const handle = await this.#fileSystem.open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await this.#fileSystem.open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #removeOrphanTemps(): Promise<void> {
    for (const directory of [this.paths.root, this.paths.legacyCanonical(".cinesim")]) {
      const names = await this.#fileSystem.readdir(directory);
      await Promise.all(
        names
          .filter((name) => name.startsWith(TEMP_PREFIX) && name.endsWith(".tmp"))
          .map((name) => this.#fileSystem.rm(join(directory, name), { force: true })),
      );
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const owner = await this.#acquireLock();
    try {
      return await operation();
    } finally {
      await this.#releaseLock(owner);
    }
  }

  async #acquireLock(): Promise<LockOwner> {
    const lockPath = this.paths.legacyCanonical(LOCK_DIRECTORY);
    const startedAt = this.#now();
    while (true) {
      const owner: LockOwner = {
        version: 1,
        token: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date(this.#now()).toISOString(),
      };
      try {
        await this.#fileSystem.mkdir(lockPath);
        await this.#fileSystem.writeFile(
          this.paths.legacyCanonical(LOCK_OWNER),
          stableJson(owner),
          {
            encoding: "utf8",
            flag: "wx",
          },
        );
        return owner;
      } catch (error) {
        if (!isExists(error)) {
          await this.#fileSystem.rmdir(lockPath).catch(() => undefined);
          throw error;
        }
        await this.#removeStaleLock(lockPath);
        if (this.#now() - startedAt >= this.#lockTimeoutMs)
          throw new Error("Timed out waiting for the canonical project writer");
        await sleep(25);
      }
    }
  }

  async #removeStaleLock(lockPath: string): Promise<void> {
    const info = await this.#fileSystem.lstat(lockPath);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Canonical write lock path is unsafe");
    const ownerSource = await this.#fileSystem
      .readFile(this.paths.legacyCanonical(LOCK_OWNER), "utf8")
      .catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
    let stale = this.#now() - info.mtimeMs >= this.#staleLockMs;
    if (ownerSource) {
      try {
        const owner = JSON.parse(ownerSource) as Partial<LockOwner>;
        if (
          owner.version === 1 &&
          owner.hostname === hostname() &&
          typeof owner.pid === "number" &&
          !this.#isProcessAlive(owner.pid)
        ) {
          stale = true;
        }
      } catch {
        // The age threshold handles incomplete owner metadata.
      }
    }
    if (!stale) return;
    await this.#fileSystem.rm(this.paths.legacyCanonical(LOCK_OWNER), { force: true });
    await this.#fileSystem.rmdir(lockPath).catch((error: unknown) => {
      if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    });
  }

  async #releaseLock(owner: LockOwner): Promise<void> {
    const ownerPath = this.paths.legacyCanonical(LOCK_OWNER);
    const source = await this.#fileSystem.readFile(ownerPath, "utf8").catch(() => null);
    if (!source) return;
    try {
      const current = JSON.parse(source) as Partial<LockOwner>;
      if (current.token !== owner.token) return;
    } catch {
      return;
    }
    await this.#fileSystem.rm(ownerPath, { force: true });
    await this.#fileSystem.rmdir(this.paths.legacyCanonical(LOCK_DIRECTORY));
  }
}

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectFileSystem } from "./file-system";
import { nodeProjectFileSystem } from "./file-system";

const LEGACY_CANONICAL_DIRECTORY = ".cinesim";
const DERIVED_DIRECTORY = ".video";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class UnsafeProjectPathError extends Error {
  readonly code = "UNSAFE_PROJECT_PATH";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeProjectPathError";
  }
}

export class ProjectPaths {
  readonly root: string;
  readonly canonicalRoot: string;

  private constructor(
    root: string,
    canonicalRoot: string,
    private readonly fileSystem: ProjectFileSystem,
  ) {
    this.root = root;
    this.canonicalRoot = canonicalRoot;
  }

  static async open(
    directory: string,
    fileSystem: ProjectFileSystem = nodeProjectFileSystem,
  ): Promise<ProjectPaths> {
    const requested = resolve(directory);
    const info = await fileSystem.lstat(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new UnsafeProjectPathError("A project root must be a real directory, not a symlink");
    }
    return new ProjectPaths(requested, await fileSystem.realpath(requested), fileSystem);
  }

  canonical(relativePath: string): string {
    if (
      relativePath !== "cinesim.toml" &&
      relativePath !== "AGENTS.md" &&
      relativePath !== ".gitignore" &&
      !/\.(?:js|jsx)$/u.test(relativePath)
    ) {
      throw new UnsafeProjectPathError(`Not a canonical project path: ${relativePath}`);
    }
    return this.#resolve(relativePath);
  }

  /** Format-v1 access is deliberately isolated to the migration reader. */
  legacyCanonical(relativePath: string): string {
    if (
      relativePath !== "cinesim.json" &&
      relativePath !== LEGACY_CANONICAL_DIRECTORY &&
      !relativePath.startsWith(`${LEGACY_CANONICAL_DIRECTORY}/`)
    ) {
      throw new UnsafeProjectPathError(`Not a format-v1 project path: ${relativePath}`);
    }
    return this.#resolve(relativePath);
  }

  source(relativePath: string): string {
    if (
      !/\.(?:js|jsx)$/u.test(relativePath) ||
      relativePath.startsWith(".video/") ||
      relativePath.includes("node_modules")
    ) {
      throw new UnsafeProjectPathError(`Not a video source module: ${relativePath}`);
    }
    return this.#resolve(relativePath);
  }

  derived(relativePath: string): string {
    if (relativePath !== DERIVED_DIRECTORY && !relativePath.startsWith(`${DERIVED_DIRECTORY}/`)) {
      throw new UnsafeProjectPathError(`Not a derived project path: ${relativePath}`);
    }
    return this.#resolve(relativePath);
  }

  projectFile(relativePath: string): string {
    return this.#resolve(relativePath);
  }

  async ensureLayout(derivedFolders: readonly string[] = []): Promise<void> {
    await this.ensureDirectory(DERIVED_DIRECTORY);
    for (const folder of derivedFolders) {
      if (folder.includes("/") || folder.includes("\\") || folder === "." || folder === "..") {
        throw new UnsafeProjectPathError(`Invalid derived folder: ${folder}`);
      }
      await this.ensureDirectory(`${DERIVED_DIRECTORY}/${folder}`);
    }
  }

  async verifyDirectories(relativePaths: readonly string[]): Promise<void> {
    for (const relativePath of relativePaths) await this.#assertExistingDirectories(relativePath);
  }

  async ensureDirectory(relativePath: string): Promise<string> {
    const parts = relativePath.split(/[\\/]/u).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      if (part === "." || part === "..")
        throw new UnsafeProjectPathError(`Unsafe project directory: ${relativePath}`);
      current = resolve(current, part);
      const info = await this.fileSystem.lstat(current).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (!info) {
        await this.fileSystem.mkdir(current);
      } else if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new UnsafeProjectPathError(`Project directory component is unsafe: ${relativePath}`);
      }
      await this.#verifyRealPath(current);
    }
    return current;
  }

  async assertSafeFile(relativePath: string, allowMissing = true): Promise<string> {
    const path = this.#resolve(relativePath);
    const parent = relative(this.root, resolve(path, ".."));
    if (parent) await this.#assertExistingDirectories(parent);
    const info = await this.fileSystem.lstat(path).catch((error: unknown) => {
      if (allowMissing && isMissing(error)) return null;
      throw error;
    });
    if (info?.isSymbolicLink() || info?.isDirectory()) {
      throw new UnsafeProjectPathError(`Project file target is unsafe: ${relativePath}`);
    }
    return path;
  }

  async assertSafeDerivedFile(relativePath: string, allowMissing = true): Promise<string> {
    this.derived(relativePath);
    return this.assertSafeFile(relativePath, allowMissing);
  }

  async assertSafeSourceFile(relativePath: string, allowMissing = true): Promise<string> {
    this.source(relativePath);
    return this.assertSafeFile(relativePath, allowMissing);
  }

  async #assertExistingDirectories(relativePath: string): Promise<void> {
    const parts = relativePath.split(sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      current = resolve(current, part);
      const info = await this.fileSystem.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new UnsafeProjectPathError(`Project directory component is unsafe: ${relativePath}`);
      }
      await this.#verifyRealPath(current);
    }
  }

  async #verifyRealPath(path: string): Promise<void> {
    const actual = await this.fileSystem.realpath(path);
    if (!this.#isInsideCanonicalRoot(actual))
      throw new UnsafeProjectPathError("Project path resolves outside the project root");
  }

  #resolve(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath))
      throw new UnsafeProjectPathError(`Unsafe project path: ${relativePath}`);
    const path = resolve(this.root, relativePath);
    if (!this.#isInside(path))
      throw new UnsafeProjectPathError(`Project path escapes the project root: ${relativePath}`);
    return path;
  }

  #isInside(path: string): boolean {
    return path === this.root || path.startsWith(`${this.root}${sep}`);
  }

  #isInsideCanonicalRoot(path: string): boolean {
    return path === this.canonicalRoot || path.startsWith(`${this.canonicalRoot}${sep}`);
  }
}

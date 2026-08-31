import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  compileVideo,
  DEFAULT_COMPILER_BUDGETS,
  type CompileResult,
  type CompilerConfig,
  type CompilerHost,
  type CompilerSource,
} from "@cinesim/compiler";
import { DEFAULT_SETTINGS, type Asset, type ProjectSettings } from "@cinesim/core";
import { serializeIr, type IrProgram } from "@cinesim/ir";
import type { ProjectFileSystem } from "./file-system";
import { nodeProjectFileSystem } from "./file-system";
import { ProjectPaths } from "./project-paths";
import {
  parseV2Manifest,
  patchManifestAddAsset,
  patchManifestAssetSource,
  patchManifestRemoveAsset,
  patchManifestSetting,
  serializeV2Manifest,
  sourceRevision,
  type V2ProjectManifest,
} from "./v2-manifest";

const MANIFEST = "cinesim.toml";
const TRANSACTION_DIRECTORY = ".video/compiler";
const JOURNAL = `${TRANSACTION_DIRECTORY}/source-transaction.json`;
const LOCK = `${TRANSACTION_DIRECTORY}/source-write.lock`;
const TEMP_PREFIX = ".cinesim-source-tx-";

interface SourceJournal {
  version: 1;
  id: string;
  previous: Record<string, string | null>;
  next: Record<string, string>;
}

export interface SourceProjectSnapshot {
  manifest: V2ProjectManifest;
  manifestSource: string;
  sources: Record<string, string>;
  revisions: Record<string, string>;
  generation: string;
  compilation: CompileResult;
}

export interface SourceProjectCommit {
  expectedGeneration: string;
  manifestSource?: string;
  sources?: Record<string, string>;
  expectedProgram?: IrProgram;
}

interface ProjectCompilation {
  result: CompileResult;
  loaded: Map<string, CompilerSource>;
}

interface PreparedSourceCommit {
  replacements: Record<string, string>;
  manifest: V2ProjectManifest;
  manifestSource: string;
  compiled: ProjectCompilation;
}

export interface CreateSourceProjectOptions {
  id: string;
  name: string;
  cloudProjectId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  settings?: ProjectSettings;
  entry?: string;
  compositionId?: string;
}

export class SourceProjectConflictError extends Error {
  readonly code = "SOURCE_PROJECT_CONFLICT";
  constructor(expected: string, actual: string) {
    super(`Source project generation changed (expected ${expected}, found ${actual}).`);
    this.name = "SourceProjectConflictError";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function compilerConfig(manifest: V2ProjectManifest): CompilerConfig {
  return {
    languageVersion: manifest.languageVersion,
    projectId: manifest.project.id,
    activeCompositionId: manifest.project.activeCompositionId,
    entry: manifest.project.entry,
    output: ".video/compiler",
    sourceMaps: true,
    strict: manifest.compiler.strict,
    assetIds: manifest.assets.map((asset) => asset.id),
    budgets: DEFAULT_COMPILER_BUDGETS,
  };
}

function normalizedImportPath(specifier: string, importer: string): string {
  const base = importer.slice(0, Math.max(0, importer.lastIndexOf("/") + 1));
  const normalized: string[] = [];
  for (const segment of `${base}${specifier}`.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") {
      normalized.push(segment);
      continue;
    }
    if (normalized.length === 0) {
      throw new Error(`Import escapes the project root: ${specifier}`);
    }
    normalized.pop();
  }
  return normalized.join("/");
}

function sourceCandidates(path: string): string[] {
  return /\.(?:js|jsx)$/u.test(path) ? [path] : [`${path}.jsx`, `${path}.js`];
}

function firstDifference(left: string, right: string): number {
  let offset = 0;
  while (offset < left.length && left[offset] === right[offset]) offset += 1;
  return offset;
}

class RepositoryCompilerHost implements CompilerHost {
  readonly loaded = new Map<string, CompilerSource>();

  constructor(
    private readonly paths: ProjectPaths,
    private readonly fileSystem: ProjectFileSystem,
    private readonly overlay: Readonly<Record<string, string>>,
  ) {}

  async read(uri: string): Promise<CompilerSource> {
    const existing = this.loaded.get(uri);
    if (existing) return existing;
    const overlaid = this.overlay[uri];
    const source =
      overlaid ??
      (await this.fileSystem.readFile(await this.paths.assertSafeSourceFile(uri, false), "utf8"));
    const result = { source, revision: sourceRevision(source) };
    this.loaded.set(uri, result);
    return result;
  }

  async resolve(specifier: string, importer: string): Promise<string> {
    if (!specifier.startsWith(".")) {
      throw new Error(`Only relative imports are supported: ${specifier}`);
    }
    for (const candidate of sourceCandidates(normalizedImportPath(specifier, importer))) {
      if (this.overlay[candidate] !== undefined) return candidate;
      try {
        await this.paths.assertSafeSourceFile(candidate, false);
        return candidate;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    throw new Error(`Cannot resolve ${specifier} from ${importer}.`);
  }
}

function projectGeneration(
  manifestSource: string,
  sources: ReadonlyMap<string, CompilerSource>,
): string {
  return sourceRevision(
    [
      [MANIFEST, manifestSource] as const,
      ...[...sources]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([uri, source]) => [uri, source.source] as const),
    ]
      .map(([uri, source]) => `${uri}\0${source}\0`)
      .join(""),
  );
}

function newProjectSource(
  compositionId: string,
  width: number,
  height: number,
  frameRate: number,
): string {
  const suffix = compositionId.replace(/^sequence_/u, "") || "main";
  return `export const main = (\n  <composition id=${JSON.stringify(compositionId)} name="Main timeline" width={${width}} height={${height}} fps={${frameRate}}>\n    <timeline id=${JSON.stringify(`timeline_${suffix}`)}>\n      <track id="track_video_1" kind="video" name="Video 1" muted={false} locked={false} />\n      <track id="track_audio_1" kind="audio" name="Audio 1" muted={false} locked={false} />\n      <track id="track_overlay_1" kind="overlay" name="Titles" muted={false} locked={false} />\n    </timeline>\n  </composition>\n);\n\nexport default main;\n`;
}

export function generatedProjectAgents(): string {
  return `# Cinesim project guidance\n\n- Canonical state is \`cinesim.toml\` plus the reachable \`.js\` and \`.jsx\` source modules.\n- Timeline structure lives only in source. Use lowercase Cinesim built-ins and capitalized user components.\n- Reference imported media with stable \`asset("asset_id")\` values declared in \`cinesim.toml\`.\n- Do not edit \`.video/\`; it contains disposable derived/runtime data.\n- Do not create project-managed \`media/\`, \`exports/\`, \`assets.json\`, \`cinesim.json\`, or \`.cinesim/\` paths.\n`;
}

export class SourceProjectRepository {
  private constructor(
    readonly paths: ProjectPaths,
    private readonly fileSystem: ProjectFileSystem,
  ) {}

  static async open(
    directory: string,
    fileSystem: ProjectFileSystem = nodeProjectFileSystem,
  ): Promise<SourceProjectRepository> {
    const paths = await ProjectPaths.open(directory, fileSystem);
    await paths.ensureLayout(["compiler"]);
    return new SourceProjectRepository(paths, fileSystem);
  }

  static async create(
    directory: string,
    options: CreateSourceProjectOptions,
    fileSystem: ProjectFileSystem = nodeProjectFileSystem,
  ): Promise<SourceProjectSnapshot> {
    const repository = await SourceProjectRepository.open(directory, fileSystem);
    const entry = options.entry ?? "main.jsx";
    const compositionId = options.compositionId ?? "sequence_main";
    const manifest: V2ProjectManifest = {
      formatVersion: 2,
      languageVersion: 1,
      project: {
        id: options.id,
        name: options.name.trim() || "Untitled project",
        entry,
        activeCompositionId: compositionId,
        ...(options.cloudProjectId === undefined ? {} : { cloudProjectId: options.cloudProjectId }),
      },
      settings: options.settings ?? DEFAULT_SETTINGS,
      compiler: { strict: true },
      assets: [],
    };
    const files: Record<string, string> = {
      [MANIFEST]: serializeV2Manifest(manifest),
      [entry]: newProjectSource(
        compositionId,
        options.width ?? 1920,
        options.height ?? 1080,
        options.frameRate ?? 30,
      ),
      "AGENTS.md": generatedProjectAgents(),
      ".gitignore": ".video/\n",
    };
    for (const relativePath of Object.keys(files)) {
      const target = await repository.paths.assertSafeFile(relativePath);
      const exists = await fileSystem
        .lstat(target)
        .then(() => true)
        .catch((error: unknown) => {
          if (isMissing(error)) return false;
          throw error;
        });
      if (exists) throw new Error(`Refusing to overwrite existing project file: ${relativePath}`);
    }
    for (const [relativePath, contents] of Object.entries(files))
      await repository.#writeNew(relativePath, contents);
    return repository.load();
  }

  async load(): Promise<SourceProjectSnapshot> {
    return this.#withLock(() => this.#loadUnlocked({}));
  }

  async commit(input: SourceProjectCommit): Promise<SourceProjectSnapshot> {
    return this.#withLock(() => this.#commitUnlocked(input));
  }

  async #commitUnlocked(input: SourceProjectCommit): Promise<SourceProjectSnapshot> {
    await this.#recover();
    const current = await this.#loadUnlocked({});
    if (current.generation !== input.expectedGeneration) {
      throw new SourceProjectConflictError(input.expectedGeneration, current.generation);
    }
    const prepared = await this.#prepareCommit(input, current);
    return prepared === null ? current : this.#publishCommit(prepared);
  }

  async #prepareCommit(
    input: SourceProjectCommit,
    current: SourceProjectSnapshot,
  ): Promise<PreparedSourceCommit | null> {
    const replacements = {
      ...input.sources,
      ...(input.manifestSource === undefined ? {} : { [MANIFEST]: input.manifestSource }),
    };
    if (Object.keys(replacements).length === 0) return null;
    for (const relativePath of Object.keys(replacements)) {
      if (relativePath === MANIFEST) await this.paths.assertSafeFile(relativePath);
      else await this.paths.assertSafeSourceFile(relativePath);
    }
    const manifestSource = replacements[MANIFEST] ?? current.manifestSource;
    const manifest = parseV2Manifest(manifestSource);
    const sourceOverlay = Object.fromEntries(
      Object.entries(replacements).filter(([path]) => path !== MANIFEST),
    );
    const compiled = await this.#compile(manifest, sourceOverlay);
    this.#assertExpectedProgram(compiled.result.ir, input.expectedProgram);
    return { replacements, manifest, manifestSource, compiled };
  }

  #assertExpectedProgram(compiledProgram: IrProgram, expectedProgram?: IrProgram): void {
    if (expectedProgram === undefined) return;
    const compiled = serializeIr(compiledProgram);
    const expected = serializeIr(expectedProgram);
    if (compiled === expected) return;
    const offset = firstDifference(compiled, expected);
    throw new Error(
      `Recompiled semantic IR does not match the validated command result near byte ${offset}: compiled=${JSON.stringify(compiled.slice(Math.max(0, offset - 100), offset + 160))} expected=${JSON.stringify(expected.slice(Math.max(0, offset - 100), offset + 160))}.`,
    );
  }

  async #publishCommit(prepared: PreparedSourceCommit): Promise<SourceProjectSnapshot> {
    const journal: SourceJournal = {
      version: 1,
      id: randomUUID(),
      previous: {},
      next: prepared.replacements,
    };
    for (const relativePath of Object.keys(prepared.replacements)) {
      journal.previous[relativePath] = await this.#readOptional(relativePath);
    }
    const temporaryFiles = new Map<string, string>();
    try {
      for (const [relativePath, contents] of Object.entries(prepared.replacements)) {
        const target = await this.paths.assertSafeFile(relativePath);
        const temporary = join(
          dirname(target),
          `${TEMP_PREFIX}${journal.id}-${basename(relativePath)}.tmp`,
        );
        await this.#writeSynced(temporary, contents);
        temporaryFiles.set(relativePath, temporary);
      }
      await this.#writeJournal(journal);
      for (const [relativePath, temporary] of temporaryFiles) {
        await this.fileSystem.rename(temporary, this.paths.projectFile(relativePath));
      }
      await this.#syncDirectory(this.paths.root);
      const published = this.#snapshot(
        prepared.manifest,
        prepared.manifestSource,
        prepared.compiled,
      );
      await this.fileSystem.rm(this.paths.derived(JOURNAL));
      await this.#syncDirectory(this.paths.derived(TRANSACTION_DIRECTORY));
      return published;
    } catch (error) {
      await this.#recover();
      throw error;
    } finally {
      await Promise.all(
        [...temporaryFiles.values()].map((path) =>
          this.fileSystem.rm(path, { force: true }).catch(() => undefined),
        ),
      );
    }
  }

  async importAsset(asset: Asset, expectedGeneration: string): Promise<SourceProjectSnapshot> {
    const current = await this.load();
    if (current.generation !== expectedGeneration)
      throw new SourceProjectConflictError(expectedGeneration, current.generation);
    return this.commit({
      expectedGeneration,
      manifestSource: patchManifestAddAsset(
        current.manifestSource,
        asset,
        sourceRevision(current.manifestSource),
      ),
    });
  }

  async removeAsset(assetId: string, expectedGeneration: string): Promise<SourceProjectSnapshot> {
    const current = await this.load();
    if (current.generation !== expectedGeneration)
      throw new SourceProjectConflictError(expectedGeneration, current.generation);
    return this.commit({
      expectedGeneration,
      manifestSource: patchManifestRemoveAsset(
        current.manifestSource,
        assetId,
        sourceRevision(current.manifestSource),
      ),
    });
  }

  async relinkAsset(
    assetId: string,
    source: Asset["source"],
    expectedGeneration: string,
  ): Promise<SourceProjectSnapshot> {
    const current = await this.load();
    if (current.generation !== expectedGeneration)
      throw new SourceProjectConflictError(expectedGeneration, current.generation);
    return this.commit({
      expectedGeneration,
      manifestSource: patchManifestAssetSource(
        current.manifestSource,
        assetId,
        source,
        sourceRevision(current.manifestSource),
      ),
    });
  }

  async updateSetting(
    key: string,
    value: unknown,
    expectedGeneration: string,
  ): Promise<SourceProjectSnapshot> {
    const current = await this.load();
    if (current.generation !== expectedGeneration)
      throw new SourceProjectConflictError(expectedGeneration, current.generation);
    return this.commit({
      expectedGeneration,
      manifestSource: patchManifestSetting(
        current.manifestSource,
        key,
        value,
        sourceRevision(current.manifestSource),
      ),
    });
  }

  async #loadUnlocked(overlay: Readonly<Record<string, string>>): Promise<SourceProjectSnapshot> {
    await this.#recover();
    const manifestSource =
      overlay[MANIFEST] ??
      (await this.fileSystem.readFile(await this.paths.assertSafeFile(MANIFEST, false), "utf8"));
    const manifest = parseV2Manifest(manifestSource);
    const compilation = await this.#compile(manifest, overlay);
    return this.#snapshot(manifest, manifestSource, compilation);
  }

  async #compile(
    manifest: V2ProjectManifest,
    overlay: Readonly<Record<string, string>>,
  ): Promise<ProjectCompilation> {
    const host = new RepositoryCompilerHost(this.paths, this.fileSystem, overlay);
    const result = await compileVideo(manifest.project.entry, compilerConfig(manifest), host);
    return { result, loaded: host.loaded };
  }

  #snapshot(
    manifest: V2ProjectManifest,
    manifestSource: string,
    compiled: ProjectCompilation,
  ): SourceProjectSnapshot {
    const sources = Object.fromEntries(
      [...compiled.loaded].map(([uri, source]) => [uri, source.source]),
    );
    const revisions = Object.fromEntries(
      [...compiled.loaded].map(([uri, source]) => [uri, source.revision]),
    );
    return {
      manifest,
      manifestSource,
      sources,
      revisions,
      generation: projectGeneration(manifestSource, compiled.loaded),
      compilation: compiled.result,
    };
  }

  async #readOptional(relativePath: string): Promise<string | null> {
    return this.fileSystem
      .readFile(await this.paths.assertSafeFile(relativePath), "utf8")
      .catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
  }

  async #writeNew(relativePath: string, contents: string): Promise<void> {
    const target = await this.paths.assertSafeFile(relativePath);
    await this.fileSystem.writeFile(target, contents, { encoding: "utf8", flag: "wx" });
    const handle = await this.fileSystem.open(target, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #writeSynced(path: string, contents: string): Promise<void> {
    await this.fileSystem.writeFile(path, contents, { encoding: "utf8", flag: "wx" });
    const handle = await this.fileSystem.open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #writeJournal(journal: SourceJournal): Promise<void> {
    const target = await this.paths.assertSafeDerivedFile(JOURNAL);
    const temporary = `${target}.${journal.id}.tmp`;
    await this.#writeSynced(temporary, serializeIr(journal));
    await this.fileSystem.rename(temporary, target);
    await this.#syncDirectory(dirname(target));
  }

  async #recover(): Promise<void> {
    const journalPath = await this.paths.assertSafeDerivedFile(JOURNAL);
    const source = await this.fileSystem.readFile(journalPath, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!source) return;
    const journal = JSON.parse(source) as SourceJournal;
    if (journal.version !== 1 || typeof journal.id !== "string")
      throw new Error("Invalid source transaction journal.");
    const allPublished = await Promise.all(
      Object.entries(journal.next).map(
        async ([path, contents]) => (await this.#readOptional(path)) === contents,
      ),
    );
    if (!allPublished.every(Boolean)) {
      for (const [relativePath, previous] of Object.entries(journal.previous)) {
        const target = await this.paths.assertSafeFile(relativePath);
        if (previous === null) await this.fileSystem.rm(target, { force: true });
        else {
          const temporary = join(
            dirname(target),
            `${TEMP_PREFIX}${journal.id}-rollback-${basename(relativePath)}.tmp`,
          );
          await this.#writeSynced(temporary, previous);
          await this.fileSystem.rename(temporary, target);
        }
      }
      await this.#syncDirectory(this.paths.root);
    }
    await this.fileSystem.rm(journalPath, { force: true });
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await this.fileSystem.open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = this.paths.derived(LOCK);
    const startedAt = Date.now();
    while (true) {
      try {
        await this.fileSystem.mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() - startedAt > 10_000)
          throw new Error("Timed out waiting for the source project writer.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await this.fileSystem.rmdir(lockPath).catch(() => undefined);
    }
  }
}

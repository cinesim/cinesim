import { cp, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compileVideo, DEFAULT_COMPILER_BUDGETS, type CompilerHost } from "@cinesim/compiler";
import {
  assertV1IrEquivalent,
  type Asset,
  type Clip,
  type Project,
  type ProjectSettings,
} from "@cinesim/core";
import { CanonicalProjectRepository } from "./canonical-repository";
import { ProjectPaths } from "./project-paths";
import { SourceProjectRepository } from "./source-project-repository";
import {
  parseV2Manifest,
  serializeV2Manifest,
  sourceRevision,
  type V2ProjectManifest,
} from "./v2-manifest";

export type DetectedProjectFormat = "missing" | "v1" | "v2" | "future" | "invalid";

export interface MigrationPlan {
  detected: DetectedProjectFormat;
  projectDirectory: string;
  backupDirectory?: string;
  entry?: string;
  plannedFiles: string[];
  issues: string[];
  summary?: {
    projects: number;
    compositions: number;
    tracks: number;
    clips: number;
    assets: number;
  };
}

export interface MigrationResult extends MigrationPlan {
  migrated: boolean;
  preservedIds: string[];
}

async function optionalSource(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

export async function detectProjectFormat(directory: string): Promise<DetectedProjectFormat> {
  const toml = await optionalSource(join(directory, "cinesim.toml"));
  if (toml !== null) {
    const match = /^format_version\s*=\s*(\d+)\s*$/mu.exec(toml);
    if (!match) return "invalid";
    const version = Number(match[1]);
    if (version === 2 && /^\[project\]\s*$/mu.test(toml)) return "v2";
    return version > 2 ? "future" : "invalid";
  }
  const json = await optionalSource(join(directory, "cinesim.json"));
  if (json === null) return "missing";
  try {
    const value = JSON.parse(json) as { version?: unknown };
    if (value.version === 1) return "v1";
    return typeof value.version === "number" && value.version > 1 ? "future" : "invalid";
  } catch {
    return "invalid";
  }
}

async function unusedEntry(directory: string): Promise<string> {
  for (const candidate of [
    "main.jsx",
    "cinesim-main.jsx",
    ...Array.from({ length: 100 }, (_, index) => `cinesim-main-${index + 2}.jsx`),
  ]) {
    if ((await optionalSource(join(directory, candidate))) === null) return candidate;
  }
  throw new Error("Could not allocate a migration entry module name.");
}

function migrationManifest(
  project: Project,
  settings: ProjectSettings,
  entry: string,
): V2ProjectManifest {
  return {
    formatVersion: 2,
    languageVersion: 1,
    project: {
      id: project.id,
      name: project.name,
      entry,
      activeCompositionId: project.activeSequenceId,
      ...(project.cloudProjectId === undefined ? {} : { cloudProjectId: project.cloudProjectId }),
    },
    settings,
    compiler: { strict: true },
    assets: structuredClone(project.assets),
  };
}

function string(value: string): string {
  return JSON.stringify(value);
}

function clipSource(clip: Clip, indent: string): string {
  const durationUs = clip.sourceEndUs - clip.sourceStartUs;
  return [
    `${indent}<clip`,
    `${indent}  id=${string(clip.id)}`,
    `${indent}  asset={asset(${string(clip.assetId)})}`,
    `${indent}  media=${string(clip.mediaKind)}`,
    ...(clip.linkedClipId === undefined ? [] : [`${indent}  linked=${string(clip.linkedClipId)}`]),
    `${indent}  start={microseconds(${clip.timelineStartUs})}`,
    `${indent}  in={microseconds(${clip.sourceStartUs})}`,
    `${indent}  duration={microseconds(${durationUs})}`,
    `${indent}  fadeIn={microseconds(${clip.fadeInUs ?? 0})}`,
    `${indent}  fadeOut={microseconds(${clip.fadeOutUs ?? 0})}`,
    `${indent}  x={px(${clip.transform.x})}`,
    `${indent}  y={px(${clip.transform.y})}`,
    `${indent}  scaleX={${clip.transform.scaleX}}`,
    `${indent}  scaleY={${clip.transform.scaleY}}`,
    `${indent}  opacity={${clip.transform.opacity}}`,
    `${indent}  fit=${string(clip.transform.fit)}`,
    `${indent}/>`,
  ].join("\n");
}

export function v1ProjectToSource(project: Project, settings: ProjectSettings): string {
  const names = new Map<string, string>();
  const compositions = project.sequences.map((sequence, index) => {
    const exportName = `composition_${index + 1}`;
    names.set(sequence.id, exportName);
    const tracks = sequence.tracks.map((track) => {
      if (track.clips.length === 0)
        return `      <track id=${string(track.id)} kind=${string(track.kind)} name=${string(track.name)} muted={${track.muted}} locked={${track.locked}} />`;
      return [
        `      <track id=${string(track.id)} kind=${string(track.kind)} name=${string(track.name)} muted={${track.muted}} locked={${track.locked}}>`,
        ...track.clips.map((clip) => clipSource(clip, "        ")),
        "      </track>",
      ].join("\n");
    });
    const suffix = sequence.id.replace(/^sequence_/u, "") || String(index + 1);
    return [
      `export const ${exportName} = (`,
      `  <composition id=${string(sequence.id)} name=${string(sequence.name)} width={${sequence.width}} height={${sequence.height}} fps={${sequence.frameRate}} background=${string(settings.backgroundColor)}>`,
      `    <timeline id=${string(`timeline_${suffix}`)}>`,
      ...tracks,
      "    </timeline>",
      "  </composition>",
      ");",
    ].join("\n");
  });
  const active = names.get(project.activeSequenceId);
  if (!active)
    throw new Error(`Active sequence not found during migration: ${project.activeSequenceId}`);
  return `${compositions.join("\n\n")}\n\nexport default ${active};\n`;
}

function summary(project: Project): NonNullable<MigrationPlan["summary"]> {
  return {
    projects: 1,
    compositions: project.sequences.length,
    tracks: project.sequences.reduce((count, sequence) => count + sequence.tracks.length, 0),
    clips: project.sequences.reduce(
      (count, sequence) =>
        count + sequence.tracks.reduce((inner, track) => inner + track.clips.length, 0),
      0,
    ),
    assets: project.assets.length,
  };
}

async function loadV1(directory: string): Promise<{ project: Project; settings: ProjectSettings }> {
  const snapshot = await (await CanonicalProjectRepository.open(directory)).load();
  return { project: snapshot.project, settings: snapshot.settings };
}

export async function checkV1Migration(directory: string): Promise<MigrationPlan> {
  const detected = await detectProjectFormat(directory);
  const projectDirectory = directory;
  if (detected !== "v1")
    return {
      detected,
      projectDirectory,
      plannedFiles: [],
      issues: detected === "v2" ? [] : [`Cannot migrate a ${detected} project.`],
    };
  try {
    const { project } = await loadV1(directory);
    const entry = await unusedEntry(directory);
    const backupDirectory = join(dirname(directory), `${basename(directory)}.cinesim-v1-backup`);
    return {
      detected,
      projectDirectory,
      backupDirectory,
      entry,
      plannedFiles: [backupDirectory, join(directory, "cinesim.toml"), join(directory, entry)],
      issues: [],
      summary: summary(project),
    };
  } catch (error) {
    return {
      detected,
      projectDirectory,
      plannedFiles: [],
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureBackup(directory: string, backup: string): Promise<void> {
  const existing = await lstat(backup).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory())
      throw new Error(`Migration backup target is not a directory: ${backup}`);
    const [current, backedUp] = await Promise.all([
      readFile(join(directory, "cinesim.json"), "utf8"),
      readFile(join(backup, "cinesim.json"), "utf8"),
    ]);
    if (current !== backedUp)
      throw new Error(`Existing migration backup does not match the current v1 project: ${backup}`);
    return;
  }
  await mkdir(backup);
  for (const relative of ["cinesim.json", ".cinesim", "AGENTS.md", ".gitignore"]) {
    const source = join(directory, relative);
    const exists = await lstat(source).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (exists) await cp(source, join(backup, relative), { recursive: true, errorOnExist: true });
  }
  await syncDirectory(backup);
  await syncDirectory(dirname(backup));
}

async function compileMigration(
  directory: string,
  manifest: V2ProjectManifest,
  manifestSource: string,
  entrySource: string,
): Promise<void> {
  const paths = await ProjectPaths.open(directory);
  const host: CompilerHost = {
    async read(uri) {
      if (uri !== manifest.project.entry)
        throw new Error(`Unexpected imported migration module: ${uri}`);
      return { source: entrySource, revision: sourceRevision(entrySource) };
    },
    async resolve(specifier, importer) {
      throw new Error(`Migrated source cannot import ${specifier} from ${importer}.`);
    },
  };
  const result = await compileVideo(
    manifest.project.entry,
    {
      languageVersion: 1,
      projectId: manifest.project.id,
      activeCompositionId: manifest.project.activeCompositionId,
      entry: manifest.project.entry,
      output: ".video/compiler",
      sourceMaps: true,
      strict: true,
      assetIds: manifest.assets.map((asset: Asset) => asset.id),
      budgets: DEFAULT_COMPILER_BUDGETS,
    },
    host,
  );
  parseV2Manifest(manifestSource);
  await paths.assertSafeSourceFile(manifest.project.entry);
  const legacy = await loadV1(directory);
  assertV1IrEquivalent(legacy.project, legacy.settings, result.ir);
}

export async function migrateV1Project(directory: string): Promise<MigrationResult> {
  const detected = await detectProjectFormat(directory);
  if (detected === "v2")
    return {
      detected,
      projectDirectory: directory,
      plannedFiles: [],
      issues: [],
      migrated: false,
      preservedIds: [],
    };
  if (detected !== "v1") throw new Error(`Cannot migrate detected project format: ${detected}`);
  const plan = await checkV1Migration(directory);
  if (plan.issues.length > 0 || !plan.entry || !plan.backupDirectory)
    throw new Error(plan.issues.join("\n") || "Migration planning failed.");
  const { project, settings } = await loadV1(directory);
  const manifest = migrationManifest(project, settings, plan.entry);
  const manifestSource = serializeV2Manifest(manifest);
  const entrySource = v1ProjectToSource(project, settings);
  await compileMigration(directory, manifest, manifestSource, entrySource);
  await ensureBackup(directory, plan.backupDirectory);
  const transactionId = `${process.pid}-${Date.now()}`;
  const manifestTarget = join(directory, "cinesim.toml");
  const entryTarget = join(directory, plan.entry);
  const manifestTemporary = join(directory, `.cinesim-migration-${transactionId}.toml.tmp`);
  const entryTemporary = join(directory, `.cinesim-migration-${transactionId}.jsx.tmp`);
  const published: string[] = [];
  try {
    await Promise.all([
      writeFile(manifestTemporary, manifestSource, { encoding: "utf8", flag: "wx" }),
      writeFile(entryTemporary, entrySource, { encoding: "utf8", flag: "wx" }),
    ]);
    await rename(entryTemporary, entryTarget);
    published.push(entryTarget);
    await rename(manifestTemporary, manifestTarget);
    published.push(manifestTarget);
    await syncDirectory(directory);
    const reopened = await (await SourceProjectRepository.open(directory)).load();
    assertV1IrEquivalent(project, settings, reopened.compilation.ir);
    await rm(join(directory, "cinesim.json"));
    await rm(join(directory, ".cinesim"), { recursive: true });
    await syncDirectory(directory);
    return {
      ...plan,
      detected: "v1",
      migrated: true,
      preservedIds: [
        project.id,
        ...project.assets.map((asset) => asset.id),
        ...project.sequences.flatMap((sequence) => [
          sequence.id,
          ...sequence.tracks.flatMap((track) => [track.id, ...track.clips.map((clip) => clip.id)]),
        ]),
      ],
    };
  } catch (error) {
    await Promise.all(
      [manifestTemporary, entryTemporary, ...published].map((path) => rm(path, { force: true })),
    );
    throw error;
  }
}

import { createHash } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  PROJECT_SETTING_DEFINITIONS,
  projectSettingDefinition,
  settingsSchema,
} from "@cinesim/core";
import type { ProjectSettings } from "@cinesim/core";
import { parse, stringify } from "smol-toml";

export interface ProjectManifest {
  formatVersion: 3;
  languageVersion: 1;
  project: {
    id: string;
    name: string;
    entry: string;
    activeCompositionId: string;
    cloudProjectId?: string;
  };
  settings: ProjectSettings;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be a TOML table.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function validateEntry(entry: string): string {
  const normalized = entry.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    !/\.(?:js|jsx)$/u.test(normalized)
  ) {
    throw new Error("project.entry must be a project-relative .js or .jsx path.");
  }
  return normalized;
}

function parseSettings(input: unknown, compilerInput: unknown): ProjectSettings {
  const tables = {
    settings: input === undefined ? {} : record(input, "settings"),
    compiler: compilerInput === undefined ? {} : record(compilerInput, "compiler"),
  };
  return settingsSchema.parse(
    Object.fromEntries(
      PROJECT_SETTING_DEFINITIONS.map((definition) => [
        definition.key,
        tables[definition.table][definition.tomlKey] ?? DEFAULT_SETTINGS[definition.key],
      ]),
    ),
  );
}

export function parseProjectManifest(source: string): ProjectManifest {
  const input = record(parse(source) as unknown, "cinesim.toml");
  if (input.format_version === 2)
    throw new Error(
      "Unsupported Cinesim project format 2. This build requires format 3 with a separate assets.toml file.",
    );
  if (input.format_version !== 3) throw new Error("cinesim.toml format_version must be 3.");
  if (input.language_version !== 1) throw new Error("cinesim.toml language_version must be 1.");
  const project = record(input.project, "project");
  const id = requiredString(project.id, "project.id");
  if (!/^project_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) throw new Error("Invalid project.id.");
  const activeCompositionId = requiredString(
    project.active_composition,
    "project.active_composition",
  );
  if (!/^sequence_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(activeCompositionId))
    throw new Error("Invalid project.active_composition.");
  const cloudProjectId = project.cloud_project_id;
  if (
    cloudProjectId !== undefined &&
    (typeof cloudProjectId !== "string" ||
      !/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u.test(cloudProjectId))
  )
    throw new Error("Invalid project.cloud_project_id.");
  if (input.assets !== undefined)
    throw new Error("cinesim.toml must not contain assets; use the canonical assets.toml catalog.");
  const compiler = input.compiler === undefined ? {} : record(input.compiler, "compiler");
  return {
    formatVersion: 3,
    languageVersion: 1,
    project: {
      id,
      name: requiredString(project.name, "project.name"),
      entry: validateEntry(requiredString(project.entry, "project.entry")),
      activeCompositionId,
      ...(cloudProjectId === undefined ? {} : { cloudProjectId }),
    },
    settings: parseSettings(input.settings, compiler),
  };
}

function manifestShape(manifest: ProjectManifest): Record<string, unknown> {
  const settings = Object.fromEntries(
    PROJECT_SETTING_DEFINITIONS.filter((definition) => definition.table === "settings").map(
      (definition) => [definition.tomlKey, manifest.settings[definition.key]],
    ),
  );
  const compiler = Object.fromEntries(
    PROJECT_SETTING_DEFINITIONS.filter((definition) => definition.table === "compiler").map(
      (definition) => [definition.tomlKey, manifest.settings[definition.key]],
    ),
  );
  return {
    format_version: 3,
    language_version: 1,
    project: {
      id: manifest.project.id,
      name: manifest.project.name,
      entry: manifest.project.entry,
      active_composition: manifest.project.activeCompositionId,
      ...(manifest.project.cloudProjectId === undefined
        ? {}
        : { cloud_project_id: manifest.project.cloudProjectId }),
    },
    settings,
    compiler,
  };
}

export function serializeProjectManifest(manifest: ProjectManifest): string {
  const source = `${stringify(manifestShape(manifest))}\n`;
  parseProjectManifest(source);
  return source;
}

export function sourceRevision(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export class StaleSourceRevisionError extends Error {
  readonly code = "STALE_SOURCE_REVISION";
  constructor(expected: string, actual: string) {
    super(`Source revision changed (expected ${expected}, found ${actual}).`);
    this.name = "StaleSourceRevisionError";
  }
}

function assertRevision(source: string, expectedRevision: string): void {
  const actual = sourceRevision(source);
  if (actual !== expectedRevision) throw new StaleSourceRevisionError(expectedRevision, actual);
}

function literal(value: unknown): string {
  const rendered = stringify({ value }).trim();
  return rendered.slice(rendered.indexOf("=") + 1).trim();
}

function tableRange(source: string, header: string): { start: number; end: number } | undefined {
  const escaped = header.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\[${escaped}\\][ \\t]*(?:\\r?\\n|$)`, "mu").exec(source);
  if (!match || match.index === undefined) return undefined;
  const next = /^\[[^\r\n]+\][ \t]*(?:\r?\n|$)/gmu;
  next.lastIndex = match.index + match[0].length;
  const following = next.exec(source);
  return { start: match.index, end: following?.index ?? source.length };
}

function replaceTableKey(source: string, table: string, key: string, value: unknown): string {
  const range = tableRange(source, table);
  if (!range) throw new Error(`Missing [${table}] table.`);
  const tableSource = source.slice(range.start, range.end);
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^(${escaped}[ \\t]*=[ \\t]*)([^\\r\\n]*)(\\r?\\n|$)`, "mu");
  if (pattern.test(tableSource)) {
    const replaced = tableSource.replace(
      pattern,
      (_match, prefix: string, _previous: string, newline: string) =>
        `${prefix}${literal(value)}${newline}`,
    );
    return `${source.slice(0, range.start)}${replaced}${source.slice(range.end)}`;
  }
  const headerEnd = tableSource.indexOf("\n") + 1;
  return `${source.slice(0, range.start)}${tableSource.slice(0, headerEnd)}${key} = ${literal(value)}\n${tableSource.slice(headerEnd)}${source.slice(range.end)}`;
}

export function patchManifestSetting(
  source: string,
  key: keyof ProjectSettings,
  value: unknown,
  expectedRevision: string,
): string {
  assertRevision(source, expectedRevision);
  const definition = projectSettingDefinition(key);
  definition.schema.parse(value);
  const next = replaceTableKey(source, definition.table, definition.tomlKey, value);
  parseProjectManifest(next);
  return next;
}

export function patchManifestProjectKey(
  source: string,
  key: "active_composition" | "entry" | "name",
  value: string,
  expectedRevision: string,
): string {
  assertRevision(source, expectedRevision);
  const next = replaceTableKey(source, "project", key, value);
  parseProjectManifest(next);
  return next;
}

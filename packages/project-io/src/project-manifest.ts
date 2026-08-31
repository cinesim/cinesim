import { createHash } from "node:crypto";
import { assetSchema, DEFAULT_SETTINGS, settingsSchema } from "@cinesim/core";
import type { Asset, ProjectSettings } from "@cinesim/core";
import { parse, stringify } from "smol-toml";

export interface ProjectManifest {
  formatVersion: 2;
  languageVersion: 1;
  project: {
    id: string;
    name: string;
    entry: string;
    activeCompositionId: string;
    cloudProjectId?: string;
  };
  settings: ProjectSettings;
  compiler: { strict: boolean };
  assets: Asset[];
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

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be finite.`);
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

function parseSettings(input: unknown): ProjectSettings {
  const value = input === undefined ? {} : record(input, "settings");
  return settingsSchema.parse({
    autosave: value.autosave ?? DEFAULT_SETTINGS.autosave,
    previewQuality: value.preview_quality ?? DEFAULT_SETTINGS.previewQuality,
    backgroundColor: value.background_color ?? DEFAULT_SETTINGS.backgroundColor,
    defaultFilmstripIntervalSeconds:
      value.filmstrip_interval_seconds ?? DEFAULT_SETTINGS.defaultFilmstripIntervalSeconds,
    proxyGeneration: value.proxy_generation ?? DEFAULT_SETTINGS.proxyGeneration,
    proxyProfile: value.proxy_profile ?? DEFAULT_SETTINGS.proxyProfile,
    proxyMaxLongEdge: value.proxy_max_long_edge ?? DEFAULT_SETTINGS.proxyMaxLongEdge,
    proxyFrameRateCap: value.proxy_frame_rate_cap ?? DEFAULT_SETTINGS.proxyFrameRateCap,
    proxyQuality: value.proxy_quality ?? DEFAULT_SETTINGS.proxyQuality,
  });
}

function parseAsset(id: string, input: unknown): Asset {
  if (!/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id))
    throw new Error(`Invalid stable asset table key: ${id}`);
  const value = record(input, `assets.${id}`);
  const source = record(value.source, `assets.${id}.source`);
  return assetSchema.parse({
    id,
    kind: value.kind,
    name: value.name,
    durationUs: value.duration_us,
    ...(optionalNumber(value.width, `assets.${id}.width`) === undefined
      ? {}
      : { width: value.width }),
    ...(optionalNumber(value.height, `assets.${id}.height`) === undefined
      ? {}
      : { height: value.height }),
    ...(optionalNumber(value.frame_rate, `assets.${id}.frame_rate`) === undefined
      ? {}
      : { frameRate: value.frame_rate }),
    ...(value.has_audio === undefined ? {} : { hasAudio: value.has_audio }),
    source:
      source.kind === "local"
        ? { kind: "local", path: requiredString(source.path, `assets.${id}.source.path`) }
        : source.kind === "cloud"
          ? {
              kind: "cloud",
              cloudAssetId: requiredString(
                source.cloud_asset_id,
                `assets.${id}.source.cloud_asset_id`,
              ),
            }
          : source,
  }) as unknown as Asset;
}

export function parseProjectManifest(source: string): ProjectManifest {
  const input = record(parse(source) as unknown, "cinesim.toml");
  if (input.format_version !== 2) throw new Error("cinesim.toml format_version must be 2.");
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
  const assetsInput = input.assets === undefined ? {} : record(input.assets, "assets");
  const compiler = input.compiler === undefined ? {} : record(input.compiler, "compiler");
  return {
    formatVersion: 2,
    languageVersion: 1,
    project: {
      id,
      name: requiredString(project.name, "project.name"),
      entry: validateEntry(requiredString(project.entry, "project.entry")),
      activeCompositionId,
      ...(cloudProjectId === undefined ? {} : { cloudProjectId }),
    },
    settings: parseSettings(input.settings),
    compiler: { strict: optionalBoolean(compiler.strict, "compiler.strict", true) },
    assets: Object.entries(assetsInput)
      .map(([assetId, asset]) => parseAsset(assetId, asset))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function manifestShape(manifest: ProjectManifest): Record<string, unknown> {
  const assets = Object.fromEntries(
    [...manifest.assets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((asset) => [
        asset.id,
        {
          kind: asset.kind,
          name: asset.name,
          duration_us: asset.durationUs,
          ...(asset.width === undefined ? {} : { width: asset.width }),
          ...(asset.height === undefined ? {} : { height: asset.height }),
          ...(asset.frameRate === undefined ? {} : { frame_rate: asset.frameRate }),
          ...(asset.hasAudio === undefined ? {} : { has_audio: asset.hasAudio }),
          source:
            asset.source.kind === "local"
              ? { kind: "local", path: asset.source.path }
              : { kind: "cloud", cloud_asset_id: asset.source.cloudAssetId },
        },
      ]),
  );
  return {
    format_version: 2,
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
    settings: {
      autosave: manifest.settings.autosave,
      preview_quality: manifest.settings.previewQuality,
      background_color: manifest.settings.backgroundColor,
      filmstrip_interval_seconds: manifest.settings.defaultFilmstripIntervalSeconds,
      proxy_generation: manifest.settings.proxyGeneration,
      proxy_profile: manifest.settings.proxyProfile,
      proxy_max_long_edge: manifest.settings.proxyMaxLongEdge,
      proxy_frame_rate_cap: manifest.settings.proxyFrameRateCap,
      proxy_quality: manifest.settings.proxyQuality,
    },
    compiler: { strict: manifest.compiler.strict },
    assets,
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
  key: string,
  value: unknown,
  expectedRevision: string,
): string {
  assertRevision(source, expectedRevision);
  const allowed = new Set([
    "autosave",
    "preview_quality",
    "background_color",
    "filmstrip_interval_seconds",
    "proxy_generation",
    "proxy_profile",
    "proxy_max_long_edge",
    "proxy_frame_rate_cap",
    "proxy_quality",
  ]);
  if (!allowed.has(key)) throw new Error(`Unsupported Cinesim setting key: ${key}`);
  const next = replaceTableKey(source, "settings", key, value);
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

function assetBlock(asset: Asset, newline: string): string {
  const fields = [
    `[assets.${asset.id}]`,
    `kind = ${literal(asset.kind)}`,
    `name = ${literal(asset.name)}`,
    `duration_us = ${asset.durationUs}`,
    ...(asset.width === undefined ? [] : [`width = ${asset.width}`]),
    ...(asset.height === undefined ? [] : [`height = ${asset.height}`]),
    ...(asset.frameRate === undefined ? [] : [`frame_rate = ${asset.frameRate}`]),
    ...(asset.hasAudio === undefined ? [] : [`has_audio = ${asset.hasAudio}`]),
    "",
    `[assets.${asset.id}.source]`,
    `kind = ${literal(asset.source.kind)}`,
    ...(asset.source.kind === "local"
      ? [`path = ${literal(asset.source.path)}`]
      : [`cloud_asset_id = ${literal(asset.source.cloudAssetId)}`]),
    "",
  ];
  return fields.join(newline);
}

function assetRanges(source: string): Array<{ id: string; start: number; end: number }> {
  const headers = [...source.matchAll(/^\[assets\.(asset_[a-zA-Z0-9_-]+)\][ \t]*(?:\r?\n|$)/gmu)];
  return headers.map((match) => {
    const id = match[1]!;
    const sourceRange = tableRange(source, `assets.${id}.source`);
    if (!sourceRange) throw new Error(`Asset ${id} is missing its source table.`);
    return { id, start: match.index!, end: sourceRange.end };
  });
}

export function patchManifestAddAsset(
  source: string,
  asset: Asset,
  expectedRevision: string,
): string {
  assertRevision(source, expectedRevision);
  assetSchema.parse(asset);
  const ranges = assetRanges(source);
  if (ranges.some((range) => range.id === asset.id))
    throw new Error(`Asset already exists: ${asset.id}`);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const nextAsset = ranges.find((range) => range.id.localeCompare(asset.id) > 0);
  const insertion = nextAsset?.start ?? ranges.at(-1)?.end ?? source.length;
  const prefix =
    insertion > 0 && !source.slice(0, insertion).endsWith(`${newline}${newline}`) ? newline : "";
  const next = `${source.slice(0, insertion)}${prefix}${assetBlock(asset, newline)}${source.slice(insertion)}`;
  parseProjectManifest(next);
  return next;
}

export function patchManifestRemoveAsset(
  source: string,
  assetId: string,
  expectedRevision: string,
): string {
  assertRevision(source, expectedRevision);
  const range = assetRanges(source).find((candidate) => candidate.id === assetId);
  if (!range) throw new Error(`Asset not found: ${assetId}`);
  const next = `${source.slice(0, range.start)}${source.slice(range.end)}`;
  parseProjectManifest(next);
  return next;
}

export function patchManifestAssetSource(
  source: string,
  assetId: string,
  assetSource: Asset["source"],
  expectedRevision: string,
): string {
  assertRevision(source, expectedRevision);
  const range = tableRange(source, `assets.${assetId}.source`);
  if (!range) throw new Error(`Asset source not found: ${assetId}`);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const replacement = [
    `[assets.${assetId}.source]`,
    `kind = ${literal(assetSource.kind)}`,
    ...(assetSource.kind === "local"
      ? [`path = ${literal(assetSource.path)}`]
      : [`cloud_asset_id = ${literal(assetSource.cloudAssetId)}`]),
    "",
  ].join(newline);
  const next = `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
  parseProjectManifest(next);
  return next;
}

import { assetSchema } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import { parse, stringify } from "smol-toml";
import { sourceRevision, StaleSourceRevisionError } from "./project-manifest";

export interface AssetManifest {
  formatVersion: 1;
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

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be finite.`);
  return value;
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
  }) as Asset;
}

function assetShape(asset: Asset): Record<string, unknown> {
  return {
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
  };
}

export function parseAssetManifest(source: string): AssetManifest {
  const input = record(parse(source) as unknown, "assets.toml");
  if (input.format_version !== 1) throw new Error("assets.toml format_version must be 1.");
  const assets = input.assets === undefined ? {} : record(input.assets, "assets");
  return {
    formatVersion: 1,
    assets: Object.entries(assets)
      .map(([assetId, asset]) => parseAsset(assetId, asset))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function serializeAssetManifest(manifest: AssetManifest): string {
  const assets = Object.fromEntries(
    [...manifest.assets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((asset) => [asset.id, assetShape(asset)]),
  );
  const source = `${stringify({ format_version: 1, assets })}\n`;
  parseAssetManifest(source);
  return source;
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
  return { start: match.index, end: next.exec(source)?.index ?? source.length };
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

export function patchAssetManifestAdd(
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
  parseAssetManifest(next);
  return next;
}

export function patchAssetManifestRemove(
  source: string,
  assetId: string,
  expectedRevision: string,
): string {
  assertRevision(source, expectedRevision);
  const range = assetRanges(source).find((candidate) => candidate.id === assetId);
  if (!range) throw new Error(`Asset not found: ${assetId}`);
  const next = `${source.slice(0, range.start)}${source.slice(range.end)}`;
  parseAssetManifest(next);
  return next;
}

export function patchAssetManifestSource(
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
  parseAssetManifest(next);
  return next;
}

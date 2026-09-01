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

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function parsedStringProperty(key: string, value: unknown, name: string): Record<string, unknown> {
  const parsed = optionalString(value, name);
  return parsed === undefined ? {} : { [key]: parsed };
}

function parsedNumberProperty(key: string, value: unknown, name: string): Record<string, unknown> {
  const parsed = optionalNumber(value, name);
  return parsed === undefined ? {} : { [key]: parsed };
}

type Technical = NonNullable<Asset["technical"]>;
type TechnicalVideo = NonNullable<Technical["video"]>;
type TechnicalAudio = NonNullable<Technical["audio"]>;

function parseColor(value: unknown, name: string): TechnicalVideo["color"] {
  const color = record(value, name);
  return {
    ...parsedStringProperty("primaries", color.primaries, `${name}.primaries`),
    ...parsedStringProperty("transfer", color.transfer, `${name}.transfer`),
    ...parsedStringProperty("matrix", color.matrix, `${name}.matrix`),
    ...(color.full_range === undefined ? {} : { fullRange: color.full_range }),
    ...parsedNumberProperty("bitDepth", color.bit_depth, `${name}.bit_depth`),
    hdr: color.hdr,
    uncertain: color.uncertain,
  } as TechnicalVideo["color"];
}

function parseVideo(value: unknown, name: string): TechnicalVideo {
  const video = record(value, name);
  const frameRate = record(video.frame_rate, `${name}.frame_rate`);
  const pixelAspectRatio = record(video.pixel_aspect_ratio, `${name}.pixel_aspect_ratio`);
  return {
    ...parsedStringProperty("codec", video.codec, `${name}.codec`),
    ...parsedStringProperty("codecParameters", video.codec_parameters, `${name}.codec_parameters`),
    ...parsedStringProperty(
      "internalCodecId",
      video.internal_codec_id,
      `${name}.internal_codec_id`,
    ),
    decoderAvailability: video.decoder_availability,
    codedWidth: video.coded_width,
    codedHeight: video.coded_height,
    displayWidth: video.display_width,
    displayHeight: video.display_height,
    rotationDegrees: video.rotation_degrees,
    pixelAspectRatio: {
      numerator: pixelAspectRatio.numerator,
      denominator: pixelAspectRatio.denominator,
    },
    frameRate: {
      mode: frameRate.mode,
      nominal: frameRate.nominal,
      minimum: frameRate.minimum,
      maximum: frameRate.maximum,
      average: frameRate.average,
      probedFrames: frameRate.probed_frames,
    },
    color: parseColor(video.color, `${name}.color`),
  } as TechnicalVideo;
}

function parseAudio(value: unknown, name: string): TechnicalAudio {
  const audio = record(value, name);
  return {
    ...parsedStringProperty("codec", audio.codec, `${name}.codec`),
    ...parsedStringProperty("codecParameters", audio.codec_parameters, `${name}.codec_parameters`),
    ...parsedStringProperty(
      "internalCodecId",
      audio.internal_codec_id,
      `${name}.internal_codec_id`,
    ),
    decoderAvailability: audio.decoder_availability,
    sampleRate: audio.sample_rate,
    channels: audio.channels,
    channelLayout: audio.channel_layout,
  } as TechnicalAudio;
}

function parseTechnical(input: unknown, name: string): Asset["technical"] {
  if (input === undefined) return undefined;
  const technical = record(input, name);
  return {
    containerMimeType: requiredString(technical.container_mime_type, `${name}.container_mime_type`),
    durationSeconds: technical.duration_seconds,
    compatibility: technical.compatibility,
    ...(technical.video === undefined
      ? {}
      : { video: parseVideo(technical.video, `${name}.video`) }),
    ...(technical.audio === undefined
      ? {}
      : { audio: parseAudio(technical.audio, `${name}.audio`) }),
  } as Asset["technical"];
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
    ...(value.technical === undefined
      ? {}
      : { technical: parseTechnical(value.technical, `assets.${id}.technical`) }),
    ...(value.input_color === undefined
      ? {}
      : {
          inputColor: {
            policy: record(value.input_color, `assets.${id}.input_color`).policy,
          },
        }),
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
    ...(asset.inputColor === undefined ? {} : { input_color: { policy: asset.inputColor.policy } }),
    ...(asset.technical === undefined ? {} : { technical: technicalShape(asset.technical) }),
    source:
      asset.source.kind === "local"
        ? { kind: "local", path: asset.source.path }
        : { kind: "cloud", cloud_asset_id: asset.source.cloudAssetId },
  };
}

function colorShape(color: TechnicalVideo["color"]): Record<string, unknown> {
  return {
    ...(color.primaries ? { primaries: color.primaries } : {}),
    ...(color.transfer ? { transfer: color.transfer } : {}),
    ...(color.matrix ? { matrix: color.matrix } : {}),
    ...(color.fullRange === undefined ? {} : { full_range: color.fullRange }),
    ...(color.bitDepth === undefined ? {} : { bit_depth: color.bitDepth }),
    hdr: color.hdr,
    uncertain: color.uncertain,
  };
}

function videoShape(video: TechnicalVideo): Record<string, unknown> {
  return {
    ...(video.codec ? { codec: video.codec } : {}),
    ...(video.codecParameters ? { codec_parameters: video.codecParameters } : {}),
    ...(video.internalCodecId ? { internal_codec_id: video.internalCodecId } : {}),
    decoder_availability: video.decoderAvailability,
    coded_width: video.codedWidth,
    coded_height: video.codedHeight,
    display_width: video.displayWidth,
    display_height: video.displayHeight,
    rotation_degrees: video.rotationDegrees,
    pixel_aspect_ratio: {
      numerator: video.pixelAspectRatio.numerator,
      denominator: video.pixelAspectRatio.denominator,
    },
    frame_rate: {
      mode: video.frameRate.mode,
      nominal: video.frameRate.nominal,
      minimum: video.frameRate.minimum,
      maximum: video.frameRate.maximum,
      average: video.frameRate.average,
      probed_frames: video.frameRate.probedFrames,
    },
    color: colorShape(video.color),
  };
}

function audioShape(audio: TechnicalAudio): Record<string, unknown> {
  return {
    ...(audio.codec ? { codec: audio.codec } : {}),
    ...(audio.codecParameters ? { codec_parameters: audio.codecParameters } : {}),
    ...(audio.internalCodecId ? { internal_codec_id: audio.internalCodecId } : {}),
    decoder_availability: audio.decoderAvailability,
    sample_rate: audio.sampleRate,
    channels: audio.channels,
    channel_layout: audio.channelLayout,
  };
}

function technicalShape(technical: Technical): Record<string, unknown> {
  return {
    container_mime_type: technical.containerMimeType,
    duration_seconds: technical.durationSeconds,
    compatibility: technical.compatibility,
    ...(technical.video ? { video: videoShape(technical.video) } : {}),
    ...(technical.audio ? { audio: audioShape(technical.audio) } : {}),
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
  const serialized = serializeAssetManifest({ formatVersion: 1, assets: [asset] });
  const root = serialized.indexOf(`[assets.${asset.id}]`);
  return serialized.slice(root).replaceAll("\n", newline);
}

function assetRanges(source: string): Array<{ id: string; start: number; end: number }> {
  const headers = [...source.matchAll(/^\[assets\.(asset_[a-zA-Z0-9_-]+)\][ \t]*(?:\r?\n|$)/gmu)];
  return headers.map((match, index) => ({
    id: match[1]!,
    start: match.index!,
    end: headers[index + 1]?.index ?? source.length,
  }));
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

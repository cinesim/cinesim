import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";
import { nextId, secondsToTimeUs, timeSeconds, timeUs } from "@cinesim/core";
import type {
  Asset,
  AssetAudioMetadata,
  AssetTechnicalMetadata,
  AssetVideoMetadata,
  DecoderAvailability,
} from "@cinesim/core";
import type {
  MediaDecoderConfigProbe,
  MediaDecoderProbe,
  MediaDecoderProbeResult,
} from "../../shared/contracts";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
import type { InputAudioTrack, InputVideoTrack } from "mediabunny";

function decoderAvailability(canDecode: boolean, decoderGlobal: "VideoDecoder" | "AudioDecoder") {
  if (canDecode) return "supported" satisfies DecoderAvailability;
  const available =
    decoderGlobal === "VideoDecoder"
      ? typeof VideoDecoder !== "undefined"
      : typeof AudioDecoder !== "undefined";
  return available ? "unsupported" : "unknown";
}

function internalCodecId(value: string | number | Uint8Array | null): string | undefined {
  if (value === null) return undefined;
  if (value instanceof Uint8Array)
    return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return String(value);
}

export function inferCodecBitDepth(codecParameters: string | null): number | undefined {
  if (!codecParameters) return undefined;
  const parts = codecParameters.split(".");
  if (parts[0] !== "vp09" && parts[0] !== "av01") return undefined;
  const value = Number(parts[3]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function channelLayout(channels: number): string {
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  return `${channels}-channel`;
}

async function inspectVideo(video: InputVideoTrack): Promise<AssetVideoMetadata> {
  const [
    codec,
    codecParameters,
    rawInternalCodecId,
    canDecode,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotationDegrees,
    pixelAspectRatio,
    frameRate,
    colorSpace,
    hdr,
  ] = await Promise.all([
    video.getCodec(),
    video.getCodecParameterString(),
    video.getInternalCodecId(),
    video.canDecode(),
    video.getCodedWidth(),
    video.getCodedHeight(),
    video.getDisplayWidth(),
    video.getDisplayHeight(),
    video.getRotation(),
    video.getPixelAspectRatio(),
    video.computeFrameRateMetrics({ targetPacketCount: 256 }),
    video.getColorSpace(),
    video.hasHighDynamicRange(),
  ]);
  const bitDepth = inferCodecBitDepth(codecParameters);
  const codecId = internalCodecId(rawInternalCodecId);
  return {
    ...(codec ? { codec } : {}),
    ...(codecParameters ? { codecParameters } : {}),
    ...(codecId ? { internalCodecId: codecId } : {}),
    decoderAvailability: decoderAvailability(canDecode, "VideoDecoder"),
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotationDegrees,
    pixelAspectRatio: {
      numerator: pixelAspectRatio.num,
      denominator: pixelAspectRatio.den,
    },
    frameRate: {
      mode: frameRate.frameRateIsConstant ? "constant" : "variable",
      nominal: frameRate.bestGuessFrameRate,
      minimum: frameRate.minFrameRate,
      maximum: frameRate.maxFrameRate,
      average: frameRate.averageFrameRate,
      probedFrames: frameRate.probedPacketCount,
    },
    color: {
      ...(colorSpace.primaries ? { primaries: colorSpace.primaries } : {}),
      ...(colorSpace.transfer ? { transfer: colorSpace.transfer } : {}),
      ...(colorSpace.matrix ? { matrix: colorSpace.matrix } : {}),
      ...(colorSpace.fullRange === null ? {} : { fullRange: colorSpace.fullRange }),
      ...(bitDepth === undefined ? {} : { bitDepth }),
      hdr,
      uncertain: !colorSpace.primaries || !colorSpace.transfer || !colorSpace.matrix,
    },
  };
}

async function inspectAudio(audio: InputAudioTrack): Promise<AssetAudioMetadata> {
  const [codec, codecParameters, rawInternalCodecId, canDecode, sampleRate, channels] =
    await Promise.all([
      audio.getCodec(),
      audio.getCodecParameterString(),
      audio.getInternalCodecId(),
      audio.canDecode(),
      audio.getSampleRate(),
      audio.getNumberOfChannels(),
    ]);
  const codecId = internalCodecId(rawInternalCodecId);
  return {
    ...(codec ? { codec } : {}),
    ...(codecParameters ? { codecParameters } : {}),
    ...(codecId ? { internalCodecId: codecId } : {}),
    decoderAvailability: decoderAvailability(canDecode, "AudioDecoder"),
    sampleRate,
    channels,
    channelLayout: channelLayout(channels),
  };
}

export function mediaCompatibility(
  kind: Asset["kind"],
  video: AssetVideoMetadata | undefined,
  audio: AssetAudioMetadata | undefined,
): AssetTechnicalMetadata["compatibility"] {
  const primary = kind === "audio" ? audio : video;
  if (!primary) return "unknown";
  if (primary.decoderAvailability === "unsupported") return "unsupported";
  const statuses = [video?.decoderAvailability, audio?.decoderAvailability].filter(Boolean);
  if (statuses.includes("unsupported")) return "partial";
  if (statuses.includes("unknown")) return "unknown";
  return "supported";
}

function boundedDescription(value: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  if (bytes.byteLength > 1024 * 1024) return undefined;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function videoProbeConfig(config: VideoDecoderConfig | null): MediaDecoderConfigProbe | undefined {
  if (!config) return undefined;
  const description = boundedDescription(config.description);
  return {
    codec: config.codec,
    ...(description ? { description } : {}),
    ...(config.codedWidth === undefined ? {} : { codedWidth: config.codedWidth }),
    ...(config.codedHeight === undefined ? {} : { codedHeight: config.codedHeight }),
  };
}

function audioProbeConfig(config: AudioDecoderConfig | null): MediaDecoderConfigProbe | undefined {
  if (!config) return undefined;
  const description = boundedDescription(config.description);
  return {
    codec: config.codec,
    ...(description ? { description } : {}),
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
  };
}

export async function isTemporaryMediaSelection(
  filePath: string,
  options: { platform?: NodeJS.Platform; temporaryDirectory?: string } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const [canonicalFile, canonicalTemporaryDirectory] = await Promise.all([
    realpath(filePath),
    realpath(options.temporaryDirectory ?? tmpdir()),
  ]);
  const pathFromTemporaryDirectory = relative(canonicalTemporaryDirectory, canonicalFile);
  return (
    pathFromTemporaryDirectory !== "" &&
    pathFromTemporaryDirectory !== ".." &&
    !pathFromTemporaryDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromTemporaryDirectory)
  );
}

export interface InspectedMedia {
  asset: Asset;
  probe: MediaDecoderProbe;
}

interface AssetInspection {
  filePath: string;
  existingIds: string[];
  durationSeconds: number;
  containerMimeType: string;
  video?: AssetVideoMetadata;
  audio?: AssetAudioMetadata;
}

function inspectedAsset(input: AssetInspection): Asset {
  const kind = input.video ? "video" : input.audio ? "audio" : "image";
  return {
    id: nextId("asset", input.existingIds),
    kind,
    name: basename(input.filePath),
    source: { kind: "local", path: input.filePath },
    durationUs: timeUs(Math.max(1, secondsToTimeUs(timeSeconds(input.durationSeconds)))),
    ...(input.video
      ? {
          width: input.video.displayWidth,
          height: input.video.displayHeight,
          frameRate: input.video.frameRate.nominal,
        }
      : {}),
    hasAudio: Boolean(input.audio),
    technical: {
      containerMimeType: input.containerMimeType,
      durationSeconds: input.durationSeconds,
      compatibility: mediaCompatibility(kind, input.video, input.audio),
      ...(input.video ? { video: input.video } : {}),
      ...(input.audio ? { audio: input.audio } : {}),
    },
    ...(input.video ? { inputColor: { policy: "source-metadata" } } : {}),
  };
}

function decoderProbe(
  assetId: Asset["id"],
  video: AssetVideoMetadata | undefined,
  audio: AssetAudioMetadata | undefined,
  videoConfig: VideoDecoderConfig | null,
  audioConfig: AudioDecoderConfig | null,
): MediaDecoderProbe {
  const normalizedVideoConfig = videoProbeConfig(videoConfig);
  const normalizedAudioConfig = audioProbeConfig(audioConfig);
  return {
    assetId,
    ...(video
      ? {
          video: {
            availability: video.decoderAvailability,
            ...(normalizedVideoConfig ? { config: normalizedVideoConfig } : {}),
          },
        }
      : {}),
    ...(audio
      ? {
          audio: {
            availability: audio.decoderAvailability,
            ...(normalizedAudioConfig ? { config: normalizedAudioConfig } : {}),
          },
        }
      : {}),
  };
}

export async function inspectMediaForImport(
  filePath: string,
  existingIds: string[],
): Promise<InspectedMedia> {
  const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) throw new Error("Unsupported media file");
    const [video, audio, durationSeconds, containerMimeType] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
      input.computeDuration(),
      input.getMimeType(),
    ]);
    const [videoMetadata, audioMetadata] = await Promise.all([
      video ? inspectVideo(video) : undefined,
      audio ? inspectAudio(audio) : undefined,
    ]);
    const asset = inspectedAsset({
      filePath,
      existingIds,
      durationSeconds,
      containerMimeType,
      ...(videoMetadata ? { video: videoMetadata } : {}),
      ...(audioMetadata ? { audio: audioMetadata } : {}),
    });
    const [videoConfig, audioConfig] = await Promise.all([
      video?.getDecoderConfig() ?? null,
      audio?.getDecoderConfig() ?? null,
    ]);
    return {
      asset,
      probe: decoderProbe(asset.id, videoMetadata, audioMetadata, videoConfig, audioConfig),
    };
  } finally {
    input.dispose();
  }
}

export async function inspectMedia(filePath: string, existingIds: string[]): Promise<Asset> {
  return (await inspectMediaForImport(filePath, existingIds)).asset;
}

export function applyMediaDecoderProbe(asset: Asset, result: MediaDecoderProbeResult): Asset {
  if (result.assetId !== asset.id || !asset.technical) return asset;
  const video = asset.technical.video
    ? {
        ...asset.technical.video,
        decoderAvailability: result.video ?? asset.technical.video.decoderAvailability,
      }
    : undefined;
  const audio = asset.technical.audio
    ? {
        ...asset.technical.audio,
        decoderAvailability: result.audio ?? asset.technical.audio.decoderAvailability,
      }
    : undefined;
  return {
    ...asset,
    technical: {
      ...asset.technical,
      compatibility: mediaCompatibility(asset.kind, video, audio),
      ...(video ? { video } : {}),
      ...(audio ? { audio } : {}),
    },
  };
}

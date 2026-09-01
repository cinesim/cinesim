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

function compatibility(
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

export async function inspectMedia(filePath: string, existingIds: string[]): Promise<Asset> {
  const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) throw new Error("Unsupported media file");
    const [video, audio, durationSeconds, containerMimeType] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
      input.computeDuration(),
      input.getMimeType(),
    ]);
    const kind = video ? "video" : audio ? "audio" : "image";
    const [videoMetadata, audioMetadata] = await Promise.all([
      video ? inspectVideo(video) : undefined,
      audio ? inspectAudio(audio) : undefined,
    ]);
    return {
      id: nextId("asset", existingIds),
      kind,
      name: basename(filePath),
      source: { kind: "local", path: filePath },
      durationUs: timeUs(Math.max(1, secondsToTimeUs(timeSeconds(durationSeconds)))),
      ...(videoMetadata
        ? {
            width: videoMetadata.displayWidth,
            height: videoMetadata.displayHeight,
            frameRate: videoMetadata.frameRate.nominal,
          }
        : {}),
      hasAudio: Boolean(audio),
      technical: {
        containerMimeType,
        durationSeconds,
        compatibility: compatibility(kind, videoMetadata, audioMetadata),
        ...(videoMetadata ? { video: videoMetadata } : {}),
        ...(audioMetadata ? { audio: audioMetadata } : {}),
      },
      ...(videoMetadata ? { inputColor: { policy: "source-metadata" } } : {}),
    };
  } finally {
    input.dispose();
  }
}

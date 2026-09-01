import type {
  MediaDecoderConfigProbe,
  MediaDecoderProbe,
  MediaDecoderProbeResult,
} from "./contracts";

interface DecoderSupport {
  supported?: boolean;
}

interface DecoderSupportRuntime {
  video?: { isConfigSupported(config: VideoDecoderConfig): Promise<DecoderSupport> };
  audio?: { isConfigSupported(config: AudioDecoderConfig): Promise<DecoderSupport> };
}

function videoConfig(config: MediaDecoderConfigProbe): VideoDecoderConfig {
  return {
    codec: config.codec,
    ...(config.description ? { description: config.description } : {}),
    ...(config.codedWidth === undefined ? {} : { codedWidth: config.codedWidth }),
    ...(config.codedHeight === undefined ? {} : { codedHeight: config.codedHeight }),
  };
}

function audioConfig(config: MediaDecoderConfigProbe): AudioDecoderConfig | null {
  if (config.sampleRate === undefined || config.numberOfChannels === undefined) return null;
  return {
    codec: config.codec,
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
    ...(config.description ? { description: config.description } : {}),
  };
}

async function probeVideo(probe: MediaDecoderProbe["video"], runtime: DecoderSupportRuntime) {
  if (!probe || probe.availability !== "unknown" || !probe.config) return probe?.availability;
  if (!runtime.video) return "unsupported" as const;
  try {
    return (await runtime.video.isConfigSupported(videoConfig(probe.config))).supported
      ? ("supported" as const)
      : ("unsupported" as const);
  } catch {
    return "unknown" as const;
  }
}

async function probeAudio(probe: MediaDecoderProbe["audio"], runtime: DecoderSupportRuntime) {
  if (!probe || probe.availability !== "unknown" || !probe.config) return probe?.availability;
  const config = audioConfig(probe.config);
  if (!config) return "unknown" as const;
  if (!runtime.audio) return "unsupported" as const;
  try {
    return (await runtime.audio.isConfigSupported(config)).supported
      ? ("supported" as const)
      : ("unsupported" as const);
  } catch {
    return "unknown" as const;
  }
}

function browserDecoderRuntime(): DecoderSupportRuntime {
  return {
    ...(typeof VideoDecoder === "undefined" ? {} : { video: VideoDecoder }),
    ...(typeof AudioDecoder === "undefined" ? {} : { audio: AudioDecoder }),
  };
}

export async function probeMediaDecoders(
  probes: readonly MediaDecoderProbe[],
  runtime: DecoderSupportRuntime = browserDecoderRuntime(),
): Promise<MediaDecoderProbeResult[]> {
  return Promise.all(
    probes.map(async (probe) => {
      const [video, audio] = await Promise.all([
        probeVideo(probe.video, runtime),
        probeAudio(probe.audio, runtime),
      ]);
      return {
        assetId: probe.assetId,
        ...(video ? { video } : {}),
        ...(audio ? { audio } : {}),
      };
    }),
  );
}

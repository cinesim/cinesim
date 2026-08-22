import type { TimeUs } from "@cinesim/core";
import { ALL_FORMATS, AudioBufferSink, Input, UrlSource, VideoSampleSink } from "mediabunny";
import type {
  AudioBufferChunk,
  AudioSource,
  VideoSource,
  VideoSourceMetadata,
} from "./video-source";

const seconds = (timeUs: TimeUs) => timeUs / 1_000_000;
const microseconds = (value: number) => Math.round(value * 1_000_000);

export class MediabunnyWebCodecsSource implements VideoSource, AudioSource {
  readonly #url: string;
  #input: Input<UrlSource> | null = null;
  #videoSink: VideoSampleSink | null = null;
  #audioSink: AudioBufferSink | null = null;
  #metadata: VideoSourceMetadata | null = null;
  #generation = 0;

  constructor(url: string) {
    this.#url = url;
  }

  async prepare(): Promise<VideoSourceMetadata> {
    if (this.#metadata) return this.#metadata;
    const input = new Input({
      source: new UrlSource(this.#url, { maxCacheSize: 64 * 1024 * 1024, parallelism: 2 }),
      formats: ALL_FORMATS,
    });
    if (!(await input.canRead())) {
      input.dispose();
      throw new Error("Unsupported media container");
    }
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    if (!videoTrack && !audioTrack) {
      input.dispose();
      throw new Error("Media has no decodable audio or video track");
    }
    if (videoTrack && !(await videoTrack.canDecode())) {
      input.dispose();
      throw new Error("The installed Chromium/WebCodecs stack cannot decode this video track");
    }
    const [duration, width, height, frameRateMetrics] = await Promise.all([
      input.computeDuration(),
      videoTrack?.getDisplayWidth() ?? 0,
      videoTrack?.getDisplayHeight() ?? 0,
      videoTrack?.computeFrameRateMetrics({ targetPacketCount: 128 }) ?? null,
    ]);
    this.#input = input;
    if (videoTrack)
      this.#videoSink = new VideoSampleSink(videoTrack, {
        hardwareAcceleration: "prefer-hardware",
      });
    if (audioTrack && (await audioTrack.canDecode()))
      this.#audioSink = new AudioBufferSink(audioTrack);
    this.#metadata = {
      durationUs: microseconds(duration),
      width,
      height,
      frameRate: frameRateMetrics?.bestGuessFrameRate || null,
      hasAudio: this.#audioSink !== null,
    };
    return this.#metadata;
  }

  async seek(_timeUs: TimeUs): Promise<void> {
    this.#generation += 1;
    await this.prepare();
  }

  async getFrame(timeUs: TimeUs): Promise<VideoFrame | null> {
    await this.prepare();
    if (!this.#videoSink) return null;
    const generation = this.#generation;
    const sample = await this.#videoSink.getSample(seconds(timeUs), { verifyKeyPackets: false });
    if (!sample) return null;
    try {
      if (generation !== this.#generation) return null;
      return sample.toVideoFrame();
    } finally {
      sample.close();
    }
  }

  async *buffers(fromUs: TimeUs, toUs: TimeUs): AsyncGenerator<AudioBufferChunk> {
    await this.prepare();
    if (!this.#audioSink) return;
    for await (const chunk of this.#audioSink.buffers(seconds(fromUs), seconds(toUs))) {
      yield {
        buffer: chunk.buffer,
        timestampUs: microseconds(chunk.timestamp),
        durationUs: microseconds(chunk.duration),
      };
    }
  }

  destroy(): void {
    this.#generation += 1;
    this.#input?.dispose();
    this.#input = null;
    this.#videoSink = null;
    this.#audioSink = null;
    this.#metadata = null;
  }
}

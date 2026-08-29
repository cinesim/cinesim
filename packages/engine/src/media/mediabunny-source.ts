import { secondsToTimeUs, timeSeconds, timeUsToSeconds } from "@cinesim/core";
import type { TimeUs } from "@cinesim/core";
import { ALL_FORMATS, AudioBufferSink, Input, UrlSource, VideoSampleSink } from "mediabunny";
import type { InputAudioTrack, InputVideoTrack } from "mediabunny";
import type {
  AudioBufferChunk,
  AudioSource,
  VideoSource,
  VideoSourceMetadata,
} from "./video-source";

export interface MediabunnyWebCodecsSourceOptions {
  inputFactory?: () => Input<UrlSource>;
  videoSinkFactory?: (track: InputVideoTrack) => VideoSampleSink;
  audioSinkFactory?: (track: InputAudioTrack) => AudioBufferSink;
}

export class MediabunnyWebCodecsSource implements VideoSource, AudioSource {
  readonly #url: string;
  #input: Input<UrlSource> | null = null;
  #videoSink: VideoSampleSink | null = null;
  #audioSink: AudioBufferSink | null = null;
  #metadata: VideoSourceMetadata | null = null;
  #preparePromise: Promise<VideoSourceMetadata> | null = null;
  #generation = 0;

  constructor(
    url: string,
    private readonly options: MediabunnyWebCodecsSourceOptions = {},
  ) {
    this.#url = url;
  }

  async prepare(): Promise<VideoSourceMetadata> {
    if (this.#metadata) return this.#metadata;
    if (this.#preparePromise) return this.#preparePromise;
    const pending = this.#prepare();
    this.#preparePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.#preparePromise === pending) this.#preparePromise = null;
    }
  }

  async #prepare(): Promise<VideoSourceMetadata> {
    const generation = this.#generation;
    const input =
      this.options.inputFactory?.() ??
      new Input({
        source: new UrlSource(this.#url, { maxCacheSize: 64 * 1024 * 1024, parallelism: 2 }),
        formats: ALL_FORMATS,
      });
    try {
      if (!(await input.canRead())) throw new Error("Unsupported media container");
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ]);
      if (!videoTrack && !audioTrack)
        throw new Error("Media has no decodable audio or video track");
      if (videoTrack && !(await videoTrack.canDecode()))
        throw new Error("The installed Chromium/WebCodecs stack cannot decode this video track");
      const [duration, width, height, frameRateMetrics] = await Promise.all([
        input.computeDuration(),
        videoTrack?.getDisplayWidth() ?? 0,
        videoTrack?.getDisplayHeight() ?? 0,
        videoTrack?.computeFrameRateMetrics({ targetPacketCount: 128 }) ?? null,
      ]);
      const videoSink = videoTrack
        ? (this.options.videoSinkFactory?.(videoTrack) ??
          new VideoSampleSink(videoTrack, { hardwareAcceleration: "prefer-hardware" }))
        : null;
      const audioSink =
        audioTrack && (await audioTrack.canDecode())
          ? (this.options.audioSinkFactory?.(audioTrack) ?? new AudioBufferSink(audioTrack))
          : null;
      if (generation !== this.#generation) throw new Error("Media source preparation was canceled");
      const metadata: VideoSourceMetadata = {
        durationUs: secondsToTimeUs(timeSeconds(duration)),
        width,
        height,
        frameRate: frameRateMetrics?.bestGuessFrameRate || null,
        hasAudio: audioSink !== null,
      };
      this.#input = input;
      this.#videoSink = videoSink;
      this.#audioSink = audioSink;
      this.#metadata = metadata;
      return metadata;
    } catch (error) {
      input.dispose();
      throw error;
    }
  }

  async seek(_timeUs: TimeUs): Promise<void> {
    this.#generation += 1;
    await this.prepare();
  }

  async getFrame(timeUs: TimeUs): Promise<VideoFrame | null> {
    await this.prepare();
    if (!this.#videoSink) return null;
    const generation = this.#generation;
    const sample = await this.#videoSink.getSample(timeUsToSeconds(timeUs), {
      verifyKeyPackets: false,
    });
    if (!sample) return null;
    try {
      if (generation !== this.#generation) return null;
      return sample.toVideoFrame();
    } finally {
      sample.close();
    }
  }

  async *frames(fromUs: TimeUs, toUs?: TimeUs): AsyncGenerator<VideoFrame> {
    await this.prepare();
    if (!this.#videoSink) return;
    const generation = this.#generation;
    const samples = this.#videoSink.samples(
      timeUsToSeconds(fromUs),
      toUs === undefined ? undefined : timeUsToSeconds(toUs),
      { verifyKeyPackets: false },
    );
    for await (const sample of samples) {
      try {
        if (generation !== this.#generation) return;
        yield sample.toVideoFrame();
      } finally {
        sample.close();
      }
    }
  }

  async *buffers(fromUs: TimeUs, toUs: TimeUs): AsyncGenerator<AudioBufferChunk> {
    await this.prepare();
    if (!this.#audioSink) return;
    for await (const chunk of this.#audioSink.buffers(
      timeUsToSeconds(fromUs),
      timeUsToSeconds(toUs),
    )) {
      yield {
        buffer: chunk.buffer,
        timestampUs: secondsToTimeUs(timeSeconds(chunk.timestamp)),
        durationUs: secondsToTimeUs(timeSeconds(chunk.duration)),
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

import type { TimeUs } from "@cinesim/core";
import type { AudioSource } from "../media/video-source";

export class WebAudioScheduler {
  readonly #context: AudioContext;
  #scheduled = new Set<AudioBufferSourceNode>();
  #generation = 0;
  #transportTimelineUs: TimeUs = 0;
  #transportContextTime = 0;

  constructor(context = new AudioContext({ latencyHint: "interactive" })) {
    this.#context = context;
  }

  get currentTimeUs(): TimeUs {
    return Math.round(this.#context.currentTime * 1_000_000);
  }

  startTransport(timelineUs: TimeUs): void {
    this.stop();
    this.#transportTimelineUs = timelineUs;
    this.#transportContextTime = this.#context.currentTime + 0.05;
  }

  async schedule(
    source: AudioSource,
    sourceFromUs: TimeUs,
    timelineFromUs: TimeUs,
    durationUs = 1_500_000,
  ): Promise<void> {
    const generation = this.#generation;
    for await (const chunk of source.buffers(sourceFromUs, sourceFromUs + durationUs)) {
      if (generation !== this.#generation) return;
      const node = this.#context.createBufferSource();
      node.buffer = chunk.buffer;
      node.connect(this.#context.destination);
      this.#scheduled.add(node);
      node.onended = () => this.#scheduled.delete(node);
      const timelineOffsetSeconds = (timelineFromUs - this.#transportTimelineUs) / 1_000_000;
      const sourceOffsetSeconds = (chunk.timestampUs - sourceFromUs) / 1_000_000;
      node.start(
        Math.max(
          this.#context.currentTime,
          this.#transportContextTime + timelineOffsetSeconds + sourceOffsetSeconds,
        ),
      );
    }
  }

  async resume(): Promise<void> {
    await this.#context.resume();
  }

  stop(): void {
    this.#generation += 1;
    for (const node of this.#scheduled) node.stop();
    this.#scheduled.clear();
  }

  async destroy(): Promise<void> {
    this.stop();
    await this.#context.close();
  }
}

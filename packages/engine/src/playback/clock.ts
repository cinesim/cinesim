import type { TimeUs } from "@cinesim/core";

export interface PlaybackClock {
  play(): void;
  pause(): void;
  seek(timeUs: TimeUs): void;
  now(): TimeUs;
  readonly playing: boolean;
}

export class MonotonicPlaybackClock implements PlaybackClock {
  #playing = false;
  #anchorTimelineUs: TimeUs = 0;
  #anchorRuntimeMs = 0;
  readonly #runtimeNow: () => number;

  constructor(runtimeNow: () => number = () => performance.now()) {
    this.#runtimeNow = runtimeNow;
  }

  get playing(): boolean {
    return this.#playing;
  }

  play(): void {
    if (this.#playing) return;
    this.#anchorRuntimeMs = this.#runtimeNow();
    this.#playing = true;
  }

  pause(): void {
    if (!this.#playing) return;
    this.#anchorTimelineUs = this.now();
    this.#playing = false;
  }

  seek(timeUs: TimeUs): void {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0)
      throw new Error("Playback time must be non-negative integer microseconds");
    this.#anchorTimelineUs = timeUs;
    this.#anchorRuntimeMs = this.#runtimeNow();
  }

  now(): TimeUs {
    if (!this.#playing) return this.#anchorTimelineUs;
    return (
      this.#anchorTimelineUs + Math.round((this.#runtimeNow() - this.#anchorRuntimeMs) * 1_000)
    );
  }
}

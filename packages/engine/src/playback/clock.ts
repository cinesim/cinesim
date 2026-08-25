import type { TimeUs } from "@cinesim/core";

export interface PlaybackClock {
  play(): void;
  pause(): void;
  seek(timeUs: TimeUs): void;
  setRate(rate: number): void;
  now(): TimeUs;
  readonly playing: boolean;
  readonly rate: number;
}

export const MAX_PLAYBACK_RATE = 8;
export const MIN_PLAYBACK_RATE = 0.25;

export function normalizePlaybackRate(rate: number): number {
  if (!Number.isFinite(rate) || rate === 0)
    throw new Error("Playback rate must be a finite, non-zero number");
  const direction = Math.sign(rate);
  const magnitude = Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, Math.abs(rate)));
  return direction * magnitude;
}

export class MonotonicPlaybackClock implements PlaybackClock {
  #playing = false;
  #anchorTimelineUs: TimeUs = 0;
  #anchorRuntimeMs = 0;
  #rate = 1;
  readonly #runtimeNow: () => number;

  constructor(runtimeNow: () => number = () => performance.now()) {
    this.#runtimeNow = runtimeNow;
  }

  get playing(): boolean {
    return this.#playing;
  }

  get rate(): number {
    return this.#rate;
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

  setRate(rate: number): void {
    const normalized = normalizePlaybackRate(rate);
    if (normalized === this.#rate) return;
    this.#anchorTimelineUs = this.now();
    this.#anchorRuntimeMs = this.#runtimeNow();
    this.#rate = normalized;
  }

  now(): TimeUs {
    if (!this.#playing) return this.#anchorTimelineUs;
    return (
      this.#anchorTimelineUs +
      Math.round((this.#runtimeNow() - this.#anchorRuntimeMs) * 1_000 * this.#rate)
    );
  }
}

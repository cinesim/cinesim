import { describe, expect, it } from "vite-plus/test";
import { audioFadeGainAt } from "../src/playback/audio-scheduler";

describe("audio fade envelope", () => {
  const envelope = {
    timelineStartUs: 1_000_000,
    timelineEndUs: 11_000_000,
    fadeInUs: 2_000_000,
    fadeOutUs: 4_000_000,
  };

  it("returns linear gain through fade in, body, and fade out", () => {
    expect(audioFadeGainAt(envelope, 1_000_000)).toBe(0);
    expect(audioFadeGainAt(envelope, 2_000_000)).toBe(0.5);
    expect(audioFadeGainAt(envelope, 5_000_000)).toBe(1);
    expect(audioFadeGainAt(envelope, 9_000_000)).toBe(0.5);
    expect(audioFadeGainAt(envelope, 11_000_000)).toBe(0);
  });
});

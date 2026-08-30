import { timeUs } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import { audioFadeGainAt } from "../src/playback/audio-scheduler";

describe("audio fade envelope", () => {
  const envelope = {
    timelineStartUs: timeUs(1_000_000),
    timelineEndUs: timeUs(11_000_000),
    fadeInUs: timeUs(2_000_000),
    fadeOutUs: timeUs(4_000_000),
  };

  it("returns linear gain through fade in, body, and fade out", () => {
    expect(audioFadeGainAt(envelope, timeUs(1_000_000))).toBe(0);
    expect(audioFadeGainAt(envelope, timeUs(2_000_000))).toBe(0.5);
    expect(audioFadeGainAt(envelope, timeUs(5_000_000))).toBe(1);
    expect(audioFadeGainAt(envelope, timeUs(9_000_000))).toBe(0.5);
    expect(audioFadeGainAt(envelope, timeUs(11_000_000))).toBe(0);
  });
});

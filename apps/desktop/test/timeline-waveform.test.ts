import { describe, expect, it } from "vite-plus/test";
import type { WaveformEnvelope } from "../src/shared/waveform-format";
import {
  timelineWaveformColumnCount,
  waveformEnvelopePath,
} from "../src/renderer/components/timeline/timeline-waveform";

describe("timeline waveform geometry", () => {
  const envelope: WaveformEnvelope = {
    version: 1,
    peakCount: 4,
    peaks: new Int16Array([-100, 200, -300, 400, -500, 600, -700, 800]),
  };

  it("adapts detail to the rendered clip width with a fixed upper bound", () => {
    expect(timelineWaveformColumnCount(800, 1_000)).toBe(400);
    expect(timelineWaveformColumnCount(20_000, 16_384)).toBe(4_096);
  });

  it("turns a source slice into a closed, normalized envelope", () => {
    const path = waveformEnvelopePath(envelope, 4_000_000, 1_000_000, 3_000_000);
    expect(path).toMatch(/^M0\.00,/);
    expect(path).toContain("1000.00,");
    expect(path.endsWith(" Z")).toBe(true);
    expect(path).not.toContain("NaN");
  });

  it("bounds path density for long artifacts", () => {
    const peaks = new Int16Array(4_096 * 2).fill(1_000);
    const path = waveformEnvelopePath(
      { version: 1, peakCount: 4_096, peaks },
      10_000_000,
      0,
      10_000_000,
      32,
    );
    expect(path.match(/ L/g)).toHaveLength(63);
  });

  it("gives a single peak a visible horizontal area", () => {
    const path = waveformEnvelopePath(
      { version: 1, peakCount: 1, peaks: new Int16Array([-12_000, 12_000]) },
      20_000,
      0,
      20_000,
    );
    expect(path).toContain("M0.00,");
    expect(path).toContain("L1000.00,");
  });
});

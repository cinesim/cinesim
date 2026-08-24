import { describe, expect, it } from "vitest";
import type { WaveformEnvelope } from "../src/shared/waveform-format";
import { waveformEnvelopePath } from "../src/renderer/components/timeline-waveform";

describe("timeline waveform geometry", () => {
  const envelope: WaveformEnvelope = {
    version: 1,
    peakCount: 4,
    peaks: new Int16Array([-100, 200, -300, 400, -500, 600, -700, 800]),
  };

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
});

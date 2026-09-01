import { describe, expect, it } from "vite-plus/test";
import {
  analyzeVisualRgba,
  buildLocalVisualAnalysis,
  MAX_VISUAL_SAMPLES,
  visualSampleTimes,
} from "../src/renderer/lib/local-visual-analysis";

function solid(red: number, green: number, blue: number): Uint8ClampedArray {
  return new Uint8ClampedArray([red, green, blue, 255, red, green, blue, 255]);
}

describe("local visual analysis", () => {
  it("bounds deterministic sample times for short and long media", () => {
    expect(visualSampleTimes(5_000_000)).toEqual([833_333, 2_500_000, 4_166_667]);
    const long = visualSampleTimes(3_600_000_000);
    expect(long).toHaveLength(MAX_VISUAL_SAMPLES);
    expect(long[0]).toBeGreaterThanOrEqual(0);
    expect(long.at(-1)).toBeLessThan(3_600_000_000);
  });

  it("extracts bounded light, color, edge, and change statistics", () => {
    const dark = solid(0, 0, 0);
    const bright = solid(255, 255, 255);
    expect(analyzeVisualRgba(dark, 2, 1)).toEqual({
      luminance: 0,
      saturation: 0,
      edgeDensity: 0,
      difference: 0,
    });
    expect(analyzeVisualRgba(bright, 2, 1, dark)).toMatchObject({
      saturation: 0,
      edgeDensity: 0,
      difference: 1,
    });
    expect(analyzeVisualRgba(bright, 2, 1, dark).luminance).toBeCloseTo(1);
  });

  it("segments strong visual changes into deterministic, conservative observations", () => {
    const result = buildLocalVisualAnalysis(
      [
        { atUs: 500_000, luminance: 0.2, saturation: 0.1, edgeDensity: 0.1, difference: 0 },
        { atUs: 1_500_000, luminance: 0.22, saturation: 0.1, edgeDensity: 0.1, difference: 0.04 },
        { atUs: 2_500_000, luminance: 0.8, saturation: 0.7, edgeDensity: 0.2, difference: 0.8 },
      ],
      4_000_000,
    );
    expect(result.coverage).toEqual([{ sourceInUs: 0, sourceOutUs: 4_000_000 }]);
    expect(result.observations).toEqual([
      expect.objectContaining({
        id: "observation_auto_0_2500000",
        description: "Dark, muted imagery with little visual change.",
        provenance: "cinesim-local-visual-v1",
      }),
      expect.objectContaining({
        id: "observation_auto_2500000_4000000",
        description: "Bright, colorful imagery with substantial visual change.",
      }),
    ]);
  });
});

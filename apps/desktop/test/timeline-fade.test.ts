import { describe, expect, it } from "vite-plus/test";
import { fadeDurationFromDrag } from "../src/renderer/components/timeline/timeline-behavior";
import { meterPercent } from "../src/renderer/components/timeline/master-level-meter";

describe("timeline fade handles", () => {
  it("moves inward from the correct clip edge and quantizes to frames", () => {
    expect(
      fadeDurationFromDrag({
        edge: "in",
        initialDurationUs: 0,
        deltaX: 60,
        pixelsPerUs: 0.000_06,
        maximumDurationUs: 5_000_000,
        frameRate: 30,
      }),
    ).toBe(1_000_000);
    expect(
      fadeDurationFromDrag({
        edge: "out",
        initialDurationUs: 0,
        deltaX: -60,
        pixelsPerUs: 0.000_06,
        maximumDurationUs: 5_000_000,
        frameRate: 30,
      }),
    ).toBe(1_000_000);
  });

  it("maps master levels onto the full meter range", () => {
    expect(meterPercent(-60)).toBe(0);
    expect(meterPercent(-30)).toBe(50);
    expect(meterPercent(0)).toBe(100);
  });
});

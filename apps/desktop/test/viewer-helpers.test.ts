import { describe, expect, it } from "vitest";
import {
  shouldShowTimelineEmptyState,
  steppedSourceTimeUs,
  viewerDisplaySize,
} from "../src/renderer/components/viewer/viewer";

describe("viewer presentation helpers", () => {
  it("fits the sequence into the available stage without scaling above 100%", () => {
    expect(
      viewerDisplaySize({ width: 1920, height: 1080 }, { width: 1000, height: 700 }, "fit"),
    ).toEqual({ width: 960, height: 540 });
    expect(
      viewerDisplaySize({ width: 640, height: 360 }, { width: 2000, height: 1200 }, "fit"),
    ).toEqual({ width: 640, height: 360 });
  });

  it("supports pixel-scale zoom levels independently of the panel size", () => {
    expect(
      viewerDisplaySize({ width: 1920, height: 1080 }, { width: 500, height: 300 }, "0.5"),
    ).toEqual({ width: 960, height: 540 });
  });

  it("suppresses the timeline empty state while source media is being previewed", () => {
    expect(shouldShowTimelineEmptyState(0, { kind: "timeline" })).toBe(true);
    expect(shouldShowTimelineEmptyState(0, { kind: "asset" })).toBe(false);
    expect(shouldShowTimelineEmptyState(1, { kind: "timeline" })).toBe(false);
  });

  it("steps source preview frames without leaving the asset duration", () => {
    expect(steppedSourceTimeUs(1_000_000, 5_000_000, 30, 1)).toBe(1_033_333);
    expect(steppedSourceTimeUs(0, 5_000_000, 30, -1)).toBe(0);
    expect(steppedSourceTimeUs(5_000_000, 5_000_000, 30, -1)).toBe(4_966_667);
  });
});

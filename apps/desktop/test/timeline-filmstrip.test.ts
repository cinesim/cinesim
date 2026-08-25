import { describe, expect, it } from "vitest";
import { timelineFilmstripTileIndices } from "../src/renderer/components/timeline/timeline-filmstrip";

const tileTimesUs = Array.from({ length: 32 }, (_, index) => index * 1_000_000);

describe("timeline filmstrip layout", () => {
  it("selects representative frames across the visible source range", () => {
    expect(
      timelineFilmstripTileIndices({
        tileTimesUs,
        sourceStartUs: 0,
        sourceEndUs: 32_000_000,
        width: 320,
        height: 45,
        tileAspectRatio: 16 / 9,
      }),
    ).toEqual([4, 12, 20, 28]);
  });

  it("uses a trimmed source range rather than the full asset", () => {
    expect(
      timelineFilmstripTileIndices({
        tileTimesUs,
        sourceStartUs: 10_000_000,
        sourceEndUs: 14_000_000,
        width: 160,
        height: 45,
        tileAspectRatio: 16 / 9,
      }),
    ).toEqual([11, 13]);
  });

  it("bounds the number of cells for extremely wide clips", () => {
    expect(
      timelineFilmstripTileIndices({
        tileTimesUs,
        sourceStartUs: 0,
        sourceEndUs: 32_000_000,
        width: 100_000,
        height: 40,
        tileAspectRatio: 16 / 9,
      }),
    ).toHaveLength(96);
  });
});

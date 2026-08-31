import { timeUs } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import {
  timelineFilmstripCellWidth,
  timelineFilmstripTileIndices,
} from "../src/renderer/components/timeline/timeline-filmstrip";

const tileTimesUs = Array.from({ length: 32 }, (_, index) => index * 1_000_000);

describe("timeline filmstrip layout", () => {
  it("keeps frame cells at the source tile aspect ratio across zoom levels", () => {
    expect(timelineFilmstripCellWidth(90, 16 / 9)).toBe(160);
    expect(timelineFilmstripCellWidth(90, 9 / 16)).toBeCloseTo(50.625);
  });

  it("selects representative frames across the visible source range", () => {
    expect(
      timelineFilmstripTileIndices({
        tileTimesUs,
        sourceStartUs: timeUs(0),
        sourceEndUs: timeUs(32_000_000),
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
        sourceStartUs: timeUs(10_000_000),
        sourceEndUs: timeUs(14_000_000),
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
        sourceStartUs: timeUs(0),
        sourceEndUs: timeUs(32_000_000),
        width: 100_000,
        height: 40,
        tileAspectRatio: 16 / 9,
      }),
    ).toHaveLength(96);
  });
});

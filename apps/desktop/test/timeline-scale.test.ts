import { describe, expect, it } from "vite-plus/test";
import { timeUs } from "@cinesim/core";
import {
  BASE_TIMELINE_PIXELS_PER_SECOND,
  timelineAnchoredScrollLeft,
  timelineContentDurationUs,
  timelineFitZoom,
  timelineMajorSecondStep,
} from "../src/renderer/lib/timeline-scale";

describe("timeline scale", () => {
  it("fits the complete sequence and end padding into the viewport", () => {
    const viewportWidth = 1_000;
    const contentDurationUs = timelineContentDurationUs(timeUs(60_000_000));
    const zoom = timelineFitZoom(timeUs(60_000_000), viewportWidth);
    const contentWidth = (contentDurationUs / 1_000_000) * BASE_TIMELINE_PIXELS_PER_SECOND * zoom;
    expect(contentWidth).toBeLessThanOrEqual(viewportWidth);
    expect(zoom).toBeLessThan(0.25);
  });

  it("retains the normal minimum for short and empty timelines", () => {
    expect(timelineFitZoom(timeUs(0), 1_000)).toBe(0.25);
    expect(timelineContentDurationUs(timeUs(0))).toBe(30_000_000);
  });

  it("uses sparse ruler ticks at very small fit scales", () => {
    expect(timelineMajorSecondStep(1)).toBe(1);
    expect(timelineMajorSecondStep(0.01)).toBe(60);
    expect(timelineMajorSecondStep(0.001)).toBe(600);
  });

  it("keeps the playhead at the same viewport position while zooming", () => {
    const nextScrollLeft = timelineAnchoredScrollLeft({
      anchorUs: timeUs(10_000_000),
      currentPixelsPerUs: 0.00005,
      currentScrollLeft: 200,
      nextPixelsPerUs: 0.0001,
      nextContentWidth: 2_000,
      viewportWidth: 800,
    });

    expect(nextScrollLeft).toBe(700);
    expect(10_000_000 * 0.0001 - nextScrollLeft).toBe(10_000_000 * 0.00005 - 200);
  });

  it("clamps anchored zoom scrolling to the content bounds", () => {
    expect(
      timelineAnchoredScrollLeft({
        anchorUs: timeUs(1_000_000),
        currentPixelsPerUs: 0.0001,
        currentScrollLeft: 0,
        nextPixelsPerUs: 0.00001,
        nextContentWidth: 1_000,
        viewportWidth: 800,
      }),
    ).toBe(0);
    expect(
      timelineAnchoredScrollLeft({
        anchorUs: timeUs(100_000_000),
        currentPixelsPerUs: 0.00001,
        currentScrollLeft: 0,
        nextPixelsPerUs: 0.0001,
        nextContentWidth: 5_000,
        viewportWidth: 800,
      }),
    ).toBe(4_200);
  });
});

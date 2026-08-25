import { describe, expect, it } from "vitest";
import {
  BASE_TIMELINE_PIXELS_PER_SECOND,
  timelineContentDurationUs,
  timelineFitZoom,
  timelineMajorSecondStep,
} from "../src/renderer/lib/timeline-scale";

describe("timeline scale", () => {
  it("fits the complete sequence and end padding into the viewport", () => {
    const viewportWidth = 1_000;
    const contentDurationUs = timelineContentDurationUs(60_000_000);
    const zoom = timelineFitZoom(60_000_000, viewportWidth);
    const contentWidth = (contentDurationUs / 1_000_000) * BASE_TIMELINE_PIXELS_PER_SECOND * zoom;
    expect(contentWidth).toBeLessThanOrEqual(viewportWidth);
    expect(zoom).toBeLessThan(0.25);
  });

  it("retains the normal minimum for short and empty timelines", () => {
    expect(timelineFitZoom(0, 1_000)).toBe(0.25);
    expect(timelineContentDurationUs(0)).toBe(30_000_000);
  });

  it("uses sparse ruler ticks at very small fit scales", () => {
    expect(timelineMajorSecondStep(1)).toBe(1);
    expect(timelineMajorSecondStep(0.01)).toBe(60);
    expect(timelineMajorSecondStep(0.001)).toBe(600);
  });
});

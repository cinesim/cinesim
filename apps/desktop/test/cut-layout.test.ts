import { describe, expect, it } from "vite-plus/test";
import {
  CUT_SPLITTER_SIZE,
  MIN_CUT_MEDIA_POOL_HEIGHT,
  MIN_CUT_TRANSCRIPT_WIDTH,
  cutRightGridTemplate,
  cutRootGridTemplate,
  cutUpperGridTemplate,
  fitCutLayout,
} from "../src/renderer/lib/cut-layout";

const storedLayout = {
  rightColumnWidth: 680,
  viewerHeight: 720,
  timelineHeight: 720,
};

describe("Cut workspace layout", () => {
  it("fits the right column inside the available workspace width", () => {
    const bounds = { width: 640, height: 900 };
    const fitted = fitCutLayout(storedLayout, bounds);

    expect(fitted.rightColumnWidth).toBe(319);
    expect(
      MIN_CUT_TRANSCRIPT_WIDTH + CUT_SPLITTER_SIZE + fitted.rightColumnWidth,
    ).toBeLessThanOrEqual(bounds.width);
    expect(cutUpperGridTemplate(fitted)).toBe("minmax(0, 1fr) 1px 319px");
  });

  it("shrinks below preferred minimums rather than overflowing a tiny workspace", () => {
    const bounds = { width: 420, height: 360 };
    const fitted = fitCutLayout(storedLayout, bounds);
    const upperHeight = bounds.height - CUT_SPLITTER_SIZE - fitted.timelineHeight;
    const mediaPoolHeight = upperHeight - CUT_SPLITTER_SIZE - fitted.viewerHeight;

    expect(fitted.rightColumnWidth).toBe(99);
    expect(fitted.timelineHeight).toBe(0);
    expect(fitted.viewerHeight).toBe(198);
    expect(mediaPoolHeight).toBe(MIN_CUT_MEDIA_POOL_HEIGHT);
  });

  it("produces bounded grid templates without intrinsic minimum tracks", () => {
    const fitted = fitCutLayout(
      { rightColumnWidth: 420, viewerHeight: 360, timelineHeight: 80 },
      { width: 1_648, height: 980 },
    );

    expect(fitted).toEqual({ rightColumnWidth: 420, viewerHeight: 360, timelineHeight: 80 });
    expect(cutRootGridTemplate(fitted)).toBe("minmax(0, 1fr) 1px 80px");
    expect(cutRightGridTemplate(fitted)).toBe("360px 1px minmax(0, 1fr)");
  });
});

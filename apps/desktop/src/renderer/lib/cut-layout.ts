import { CUT_LAYOUT_LIMITS } from "../../shared/api";
import type { CutLayoutState } from "../../shared/api";

export const CUT_SPLITTER_SIZE = 1;
export const MIN_CUT_TRANSCRIPT_WIDTH = 320;
export const MIN_CUT_MEDIA_POOL_HEIGHT = 160;

function clampToAvailable(
  value: number,
  preferredMinimum: number,
  maximum: number,
  available: number,
): number {
  const fittedMaximum = Math.max(0, Math.min(maximum, available));
  const fittedMinimum = Math.min(preferredMinimum, fittedMaximum);
  return Math.min(Math.max(value, fittedMinimum), fittedMaximum);
}

export function fitCutLayout(
  layout: CutLayoutState,
  bounds: { width: number; height: number },
): CutLayoutState {
  const rightColumnAvailable =
    bounds.width > 0
      ? bounds.width - MIN_CUT_TRANSCRIPT_WIDTH - CUT_SPLITTER_SIZE
      : CUT_LAYOUT_LIMITS.rightColumnWidth.max;
  const minimumUpperHeight =
    CUT_LAYOUT_LIMITS.viewerHeight.min + CUT_SPLITTER_SIZE + MIN_CUT_MEDIA_POOL_HEIGHT;
  const timelineAvailable =
    bounds.height > 0
      ? bounds.height - CUT_SPLITTER_SIZE - minimumUpperHeight
      : CUT_LAYOUT_LIMITS.timelineHeight.max;
  const timelineHeight = clampToAvailable(
    layout.timelineHeight,
    CUT_LAYOUT_LIMITS.timelineHeight.min,
    CUT_LAYOUT_LIMITS.timelineHeight.max,
    timelineAvailable,
  );
  const upperHeight =
    bounds.height > 0
      ? Math.max(0, bounds.height - CUT_SPLITTER_SIZE - timelineHeight)
      : CUT_LAYOUT_LIMITS.viewerHeight.max + CUT_SPLITTER_SIZE + MIN_CUT_MEDIA_POOL_HEIGHT;
  const viewerAvailable = upperHeight - CUT_SPLITTER_SIZE - MIN_CUT_MEDIA_POOL_HEIGHT;

  return {
    rightColumnWidth: clampToAvailable(
      layout.rightColumnWidth,
      CUT_LAYOUT_LIMITS.rightColumnWidth.min,
      CUT_LAYOUT_LIMITS.rightColumnWidth.max,
      rightColumnAvailable,
    ),
    viewerHeight: clampToAvailable(
      layout.viewerHeight,
      CUT_LAYOUT_LIMITS.viewerHeight.min,
      CUT_LAYOUT_LIMITS.viewerHeight.max,
      viewerAvailable,
    ),
    timelineHeight,
  };
}

export function cutUpperGridTemplate(layout: CutLayoutState): string {
  return `minmax(0, 1fr) ${CUT_SPLITTER_SIZE}px ${layout.rightColumnWidth}px`;
}

export function cutRootGridTemplate(layout: CutLayoutState): string {
  return `minmax(0, 1fr) ${CUT_SPLITTER_SIZE}px ${layout.timelineHeight}px`;
}

export function cutRightGridTemplate(layout: CutLayoutState): string {
  return `${layout.viewerHeight}px ${CUT_SPLITTER_SIZE}px minmax(0, 1fr)`;
}

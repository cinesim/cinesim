export const BASE_TIMELINE_PIXELS_PER_SECOND = 86;
export const ABSOLUTE_MIN_TIMELINE_ZOOM = 0.000001;
export const DEFAULT_MIN_TIMELINE_ZOOM = 0.25;
export const MAX_TIMELINE_ZOOM = 4;

const MIN_CONTENT_DURATION_US = 30_000_000;
const END_PADDING_US = 5_000_000;
const MIN_MAJOR_TICK_PIXELS = 48;

export function timelineContentDurationUs(sequenceDurationUs: TimeUs): TimeUs {
  return timeUs(
    Math.max(MIN_CONTENT_DURATION_US, Math.max(0, sequenceDurationUs) + END_PADDING_US),
  );
}

export function timelineFitZoom(sequenceDurationUs: TimeUs, viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return DEFAULT_MIN_TIMELINE_ZOOM;
  const durationSeconds = timeUsToSeconds(timelineContentDurationUs(sequenceDurationUs));
  const availableWidth = Math.max(1, viewportWidth - 2);
  return Math.min(
    DEFAULT_MIN_TIMELINE_ZOOM,
    Math.max(
      ABSOLUTE_MIN_TIMELINE_ZOOM,
      availableWidth / (durationSeconds * BASE_TIMELINE_PIXELS_PER_SECOND),
    ),
  );
}

export function clampTimelineZoom(zoom: number, minimum = ABSOLUTE_MIN_TIMELINE_ZOOM): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1;
  return Math.min(MAX_TIMELINE_ZOOM, Math.max(minimum, safeZoom));
}

export function timelineMajorSecondStep(zoom: number): number {
  const secondsForReadableTick = Math.max(
    1,
    MIN_MAJOR_TICK_PIXELS /
      (BASE_TIMELINE_PIXELS_PER_SECOND * Math.max(ABSOLUTE_MIN_TIMELINE_ZOOM, zoom)),
  );
  const magnitude = 10 ** Math.floor(Math.log10(secondsForReadableTick));
  return (
    magnitude *
    ([1, 2, 3, 5, 6, 10].find((step) => step * magnitude >= secondsForReadableTick) ?? 10)
  );
}
import { timeUs, timeUsToSeconds } from "@cinesim/core";
import type { TimeUs } from "@cinesim/core";

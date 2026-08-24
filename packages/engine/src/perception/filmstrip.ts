import type { TimeUs } from "@cinesim/core";

export const DEFAULT_FILMSTRIP_TILE_LIMIT = 32;

export function filmstripSampleTimes(
  durationUs: TimeUs,
  maximumTiles = DEFAULT_FILMSTRIP_TILE_LIMIT,
): TimeUs[] {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) return [];
  if (!Number.isSafeInteger(maximumTiles) || maximumTiles < 1 || maximumTiles > 64)
    throw new Error("Filmstrip tile limit must be an integer from 1 to 64");
  const count = Math.min(maximumTiles, Math.max(1, Math.ceil(durationUs / 1_000_000)));
  if (count === 1) return [Math.round((durationUs - 1) / 2)];
  return Array.from({ length: count }, (_, index) =>
    Math.round((index / (count - 1)) * Math.max(0, durationUs - 1)),
  );
}

export function pointerSourceTimeUs(
  clientX: number,
  left: number,
  width: number,
  durationUs: TimeUs,
): TimeUs {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width)) return 0;
  const ratio = Math.min(1, Math.max(0, width > 0 ? (clientX - left) / width : 0));
  return Math.round(ratio * Math.max(0, durationUs - 1));
}

export function nearestSampleIndex(timesUs: readonly TimeUs[], sourceTimeUs: TimeUs): number {
  if (timesUs.length === 0) return 0;
  let low = 0;
  let high = timesUs.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timesUs[middle]! < sourceTimeUs) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  return sourceTimeUs - timesUs[low - 1]! <= timesUs[low]! - sourceTimeUs ? low - 1 : low;
}

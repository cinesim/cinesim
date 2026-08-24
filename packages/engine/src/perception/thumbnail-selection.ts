import type { TimeUs } from "@cinesim/core";

export interface ThumbnailScore {
  score: number;
  rejected: boolean;
  exposure: number;
  contrast: number;
  edgeEnergy: number;
  boundaryWeight: number;
}

export function thumbnailCandidateTimes(durationUs: TimeUs): TimeUs[] {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) return [];
  const count = Math.min(24, Math.max(12, Math.ceil(durationUs / 300_000_000)));
  const edge = Math.min(2_000_000, Math.floor(durationUs * 0.08));
  const start = Math.min(edge, Math.max(0, durationUs - 1));
  const end = Math.max(start, durationUs - 1 - edge);
  if (start === end) return [start];
  return Array.from({ length: count }, (_, index) =>
    Math.round(start + (index / (count - 1)) * (end - start)),
  );
}

export function scoreThumbnailRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  sourceTimeUs: TimeUs,
  durationUs: TimeUs,
): ThumbnailScore {
  if (width < 2 || height < 2 || rgba.length < width * height * 4)
    throw new Error("Invalid thumbnail analysis pixels");
  const luminance = new Float32Array(width * height);
  let sum = 0;
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    const value =
      (rgba[offset]! * 0.2126 + rgba[offset + 1]! * 0.7152 + rgba[offset + 2]! * 0.0722) / 255;
    luminance[index] = value;
    sum += value;
  }
  const mean = sum / luminance.length;
  let varianceSum = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = luminance[index]!;
      varianceSum += (value - mean) ** 2;
      if (x + 1 < width) {
        edgeSum += Math.abs(value - luminance[index + 1]!);
        edgeCount += 1;
      }
      if (y + 1 < height) {
        edgeSum += Math.abs(value - luminance[index + width]!);
        edgeCount += 1;
      }
    }
  }
  const contrast = Math.sqrt(varianceSum / luminance.length);
  const edgeEnergy = edgeCount ? edgeSum / edgeCount : 0;
  const exposure = 1 - Math.min(1, Math.abs(mean - 0.5) * 2);
  const ratio = durationUs > 1 ? sourceTimeUs / (durationUs - 1) : 0.5;
  const boundaryWeight = Math.min(1, Math.max(0, Math.min(ratio, 1 - ratio) * 4));
  const rejected = mean < 0.035 || mean > 0.965 || contrast < 0.018 || edgeEnergy < 0.006;
  const score = rejected
    ? -1
    : exposure * 0.3 +
      Math.min(1, contrast * 5) * 0.3 +
      Math.min(1, edgeEnergy * 8) * 0.3 +
      boundaryWeight * 0.1;
  return { score, rejected, exposure, contrast, edgeEnergy, boundaryWeight };
}

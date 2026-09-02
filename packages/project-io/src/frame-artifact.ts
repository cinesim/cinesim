import { timeUs } from "@cinesim/core";
import type { TimeUs } from "@cinesim/core";

export type DerivedFrameTarget =
  | { kind: "asset"; assetId: string }
  | { kind: "timeline"; sequenceId: string };

export type DerivedFrameQuality = "low" | "medium" | "high";

export function normalizeDerivedFrameTime(
  requestedAtUs: number,
  durationUs: TimeUs,
  frameRate: number,
): TimeUs {
  if (!Number.isFinite(requestedAtUs) || requestedAtUs < 0)
    throw new Error("Frame time must be nonnegative");
  const safeRate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 30;
  const frameIndex = Math.floor(
    (Math.min(requestedAtUs, durationUs) * safeRate) / 1_000_000 + 0.000_1,
  );
  const lastFrame = Math.max(0, Math.ceil((durationUs * safeRate) / 1_000_000) - 1);
  return timeUs(Math.round((Math.min(frameIndex, lastFrame) * 1_000_000) / safeRate));
}

export function derivedFrameArtifactBaseName(
  target: DerivedFrameTarget,
  normalizedTimeUs: TimeUs,
  quality: DerivedFrameQuality,
): string {
  const targetKey = target.kind === "asset" ? target.assetId : `timeline-${target.sequenceId}`;
  return `${targetKey}-${normalizedTimeUs}-${quality}`;
}

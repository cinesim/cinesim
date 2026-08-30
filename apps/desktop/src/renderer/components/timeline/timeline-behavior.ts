import { timeUs } from "@cinesim/core";
import type { Asset, TimeUs, Track } from "@cinesim/core";

export type TimelinePaletteId = "northern-lights" | "desert-bloom" | "coastal";

export const TIMELINE_PALETTES: ReadonlyArray<{
  id: TimelinePaletteId;
  name: string;
  colors: { video: string; overlay: string; audio: string; image: string };
}> = [
  {
    id: "northern-lights",
    name: "Northern Lights",
    colors: { video: "#506fa3", overlay: "#80649b", audio: "#397968", image: "#aa7a42" },
  },
  {
    id: "desert-bloom",
    name: "Desert Bloom",
    colors: { video: "#a85e58", overlay: "#895d82", audio: "#688263", image: "#b18445" },
  },
  {
    id: "coastal",
    name: "Coastal",
    colors: { video: "#397d91", overlay: "#6870a0", audio: "#438273", image: "#9b7652" },
  },
];

export const FULL_TIMELINE_TRACK_CHROME_WIDTH = 168 + 72;

export function isTimelinePaletteId(value: string | null): value is TimelinePaletteId {
  return TIMELINE_PALETTES.some((palette) => palette.id === value);
}

export function timelinePaletteColor(
  paletteId: TimelinePaletteId,
  track: Track,
  asset: Asset | undefined,
): string {
  const palette = TIMELINE_PALETTES.find((candidate) => candidate.id === paletteId);
  if (!palette) throw new Error(`Unknown timeline palette: ${paletteId}`);
  if (track.kind === "audio") return palette.colors.audio;
  if (track.kind === "overlay") return palette.colors.overlay;
  return asset?.kind === "image" ? palette.colors.image : palette.colors.video;
}

export function fadeDurationFromDrag({
  edge,
  initialDurationUs,
  deltaX,
  pixelsPerUs,
  maximumDurationUs,
  frameRate,
}: {
  edge: "in" | "out";
  initialDurationUs: TimeUs;
  deltaX: number;
  pixelsPerUs: number;
  maximumDurationUs: TimeUs;
  frameRate: number;
}): TimeUs {
  const rawDurationUs = initialDurationUs + (edge === "in" ? deltaX : -deltaX) / pixelsPerUs;
  const frameDurationUs = 1_000_000 / Math.max(1, frameRate);
  const quantized = Math.round(rawDurationUs / frameDurationUs) * frameDurationUs;
  return timeUs(Math.round(Math.min(maximumDurationUs, Math.max(0, quantized))));
}

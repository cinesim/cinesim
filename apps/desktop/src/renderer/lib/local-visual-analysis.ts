import type { VisualIndexObservation, VisualIndexRange } from "@cinesim/project-io";

export const LOCAL_VISUAL_ANALYZER_VERSION = "cinesim-local-visual-v1";
export const MAX_VISUAL_SAMPLES = 180;

export interface VisualSample {
  atUs: number;
  luminance: number;
  saturation: number;
  edgeDensity: number;
  difference: number;
}

export interface VisualAnalysisResult {
  options: Record<string, boolean | number | string | null>;
  coverage: VisualIndexRange[];
  observations: VisualIndexObservation[];
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function pixelLuminance(red: number, green: number, blue: number): number {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function pixelSaturation(red: number, green: number, blue: number): number {
  const maximum = Math.max(red, green, blue);
  if (maximum === 0) return 0;
  return (maximum - Math.min(red, green, blue)) / maximum;
}

function luminanceAt(pixels: Uint8ClampedArray, offset: number): number {
  return pixelLuminance(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!);
}

function horizontalEdge(
  pixels: Uint8ClampedArray,
  offset: number,
  x: number,
  current: number,
): number {
  return x === 0 ? 0 : Math.abs(current - luminanceAt(pixels, offset - 4));
}

function verticalEdge(
  pixels: Uint8ClampedArray,
  offset: number,
  y: number,
  width: number,
  current: number,
): number {
  return y === 0 ? 0 : Math.abs(current - luminanceAt(pixels, offset - width * 4));
}

function pixelDifference(
  pixels: Uint8ClampedArray,
  previous: Uint8ClampedArray | undefined,
  offset: number,
): number {
  if (!previous) return 0;
  return (
    (Math.abs(pixels[offset]! - previous[offset]!) +
      Math.abs(pixels[offset + 1]! - previous[offset + 1]!) +
      Math.abs(pixels[offset + 2]! - previous[offset + 2]!)) /
    (3 * 255)
  );
}

export function visualSampleTimes(durationUs: number): number[] {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) return [];
  const preferredSamples = Math.max(1, Math.ceil(durationUs / 2_000_000));
  const count = Math.min(MAX_VISUAL_SAMPLES, preferredSamples);
  const intervalUs = durationUs / count;
  return Array.from({ length: count }, (_, index) =>
    Math.min(durationUs - 1, Math.max(0, Math.round((index + 0.5) * intervalUs))),
  );
}

export function analyzeVisualRgba(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  previous?: Uint8ClampedArray,
): Omit<VisualSample, "atUs"> {
  if (pixels.length !== width * height * 4) throw new Error("Visual sample dimensions are invalid");
  if (previous && previous.length !== pixels.length)
    throw new Error("Visual sample history dimensions are invalid");
  let luminance = 0;
  let saturation = 0;
  let edges = 0;
  let differences = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset]!;
      const green = pixels[offset + 1]!;
      const blue = pixels[offset + 2]!;
      const current = pixelLuminance(red, green, blue);
      luminance += current;
      saturation += pixelSaturation(red, green, blue);
      edges += horizontalEdge(pixels, offset, x, current);
      edges += verticalEdge(pixels, offset, y, width, current);
      differences += pixelDifference(pixels, previous, offset);
    }
  }
  const pixelCount = Math.max(1, width * height);
  const compared = height * Math.max(0, width - 1) + width * Math.max(0, height - 1);
  return {
    luminance: clampUnit(luminance / pixelCount),
    saturation: clampUnit(saturation / pixelCount),
    edgeDensity: clampUnit(edges / Math.max(1, compared)),
    difference: previous ? clampUnit(differences / pixelCount) : 0,
  };
}

function average(samples: readonly VisualSample[], key: keyof Omit<VisualSample, "atUs">): number {
  return samples.reduce((total, sample) => total + sample[key], 0) / Math.max(1, samples.length);
}

function visualTags(samples: readonly VisualSample[]): string[] {
  const luminance = average(samples, "luminance");
  const saturation = average(samples, "saturation");
  const difference = average(samples, "difference");
  return [
    luminance < 0.28 ? "dark" : luminance > 0.7 ? "bright" : "mid-tone",
    saturation < 0.18 ? "muted" : saturation > 0.55 ? "colorful" : "natural-color",
    difference < 0.08
      ? "low-visual-change"
      : difference > 0.24
        ? "high-visual-change"
        : "visual-change",
  ].sort();
}

function visualDescription(tags: readonly string[]): string {
  const light = tags.includes("dark") ? "Dark" : tags.includes("bright") ? "Bright" : "Mid-tone";
  const color = tags.includes("muted")
    ? "muted"
    : tags.includes("colorful")
      ? "colorful"
      : "natural-color";
  const change = tags.includes("low-visual-change")
    ? "little"
    : tags.includes("high-visual-change")
      ? "substantial"
      : "moderate";
  return `${light}, ${color} imagery with ${change} visual change.`;
}

function segmentSamples(samples: readonly VisualSample[]): VisualSample[][] {
  const segments: VisualSample[][] = [];
  for (const sample of samples) {
    const current = segments.at(-1);
    if (!current || (sample.difference >= 0.32 && current.length > 0)) segments.push([sample]);
    else current.push(sample);
  }
  return segments;
}

export function buildLocalVisualAnalysis(
  samples: readonly VisualSample[],
  durationUs: number,
): VisualAnalysisResult {
  if (samples.length === 0 || durationUs <= 0)
    return {
      options: { analyzer: LOCAL_VISUAL_ANALYZER_VERSION, sampleCount: 0 },
      coverage: [],
      observations: [],
    };
  const segments = segmentSamples(samples);
  const observations = segments.map((segment, index) => {
    const next = segments[index + 1];
    const sourceInUs = index === 0 ? 0 : segment[0]!.atUs;
    const sourceOutUs = next ? next[0]!.atUs : durationUs;
    const tags = visualTags(segment);
    return {
      id: `observation_auto_${sourceInUs}_${sourceOutUs}`,
      sourceInUs,
      sourceOutUs,
      description: visualDescription(tags),
      tags,
      confidence: 0.35,
      provenance: LOCAL_VISUAL_ANALYZER_VERSION,
    } satisfies VisualIndexObservation;
  });
  return {
    options: {
      analyzer: LOCAL_VISUAL_ANALYZER_VERSION,
      sampleCount: samples.length,
      sampleLimit: MAX_VISUAL_SAMPLES,
    },
    coverage: [{ sourceInUs: 0, sourceOutUs: durationUs }],
    observations,
  };
}

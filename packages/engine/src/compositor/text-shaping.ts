import * as harfbuzz from "harfbuzzjs";
import { decompress } from "woff2-encoder";

const QUADRATIC_STEPS = 8;
const CUBIC_STEPS = 12;

interface Point {
  x: number;
  y: number;
}

interface Segment {
  from: Point;
  to: Point;
}

export interface ShapedGlyph {
  glyphId: number;
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

export interface GlyphOutline {
  glyphId: number;
  commands: harfbuzz.SvgPathCommand[];
  extents: harfbuzz.GlyphExtents;
}

export interface RasterizedGlyph {
  pixels: Uint8Array;
  width: number;
  height: number;
  plane: { left: number; top: number; right: number; bottom: number };
  distanceRange: number;
}

function point(x: number, y: number): Point {
  return { x, y };
}

function quadratic(from: Point, control: Point, to: Point, progress: number): Point {
  const remaining = 1 - progress;
  return point(
    remaining * remaining * from.x + 2 * remaining * progress * control.x + progress ** 2 * to.x,
    remaining * remaining * from.y + 2 * remaining * progress * control.y + progress ** 2 * to.y,
  );
}

function cubic(from: Point, first: Point, second: Point, to: Point, progress: number): Point {
  const remaining = 1 - progress;
  return point(
    remaining ** 3 * from.x +
      3 * remaining ** 2 * progress * first.x +
      3 * remaining * progress ** 2 * second.x +
      progress ** 3 * to.x,
    remaining ** 3 * from.y +
      3 * remaining ** 2 * progress * first.y +
      3 * remaining * progress ** 2 * second.y +
      progress ** 3 * to.y,
  );
}

function appendCurve(
  segments: Segment[],
  from: Point,
  steps: number,
  sample: (progress: number) => Point,
): Point {
  let previous = from;
  for (let step = 1; step <= steps; step += 1) {
    const next = sample(step / steps);
    segments.push({ from: previous, to: next });
    previous = next;
  }
  return previous;
}

function lineCommand(current: Point, values: number[], segments: Segment[]): Point {
  const next = point(values[0]!, values[1]!);
  segments.push({ from: current, to: next });
  return next;
}

function quadraticCommand(current: Point, values: number[], segments: Segment[]): Point {
  const control = point(values[0]!, values[1]!);
  const end = point(values[2]!, values[3]!);
  return appendCurve(segments, current, QUADRATIC_STEPS, (progress) =>
    quadratic(current, control, end, progress),
  );
}

function cubicCommand(current: Point, values: number[], segments: Segment[]): Point {
  const first = point(values[0]!, values[1]!);
  const second = point(values[2]!, values[3]!);
  const end = point(values[4]!, values[5]!);
  return appendCurve(segments, current, CUBIC_STEPS, (progress) =>
    cubic(current, first, second, end, progress),
  );
}

export function flattenGlyphPath(commands: readonly harfbuzz.SvgPathCommand[]): Segment[] {
  const segments: Segment[] = [];
  let current = point(0, 0);
  let contourStart = current;
  for (const command of commands) {
    if (command.type === "M") {
      current = point(command.values[0]!, command.values[1]!);
      contourStart = current;
    } else if (command.type === "L") {
      current = lineCommand(current, command.values, segments);
    } else if (command.type === "Q") {
      current = quadraticCommand(current, command.values, segments);
    } else if (command.type === "C") {
      current = cubicCommand(current, command.values, segments);
    } else if (
      command.type === "Z" &&
      (current.x !== contourStart.x || current.y !== contourStart.y)
    ) {
      segments.push({ from: current, to: contourStart });
      current = contourStart;
    }
  }
  return segments;
}

function distanceToSegment(sample: Point, segment: Segment): number {
  const dx = segment.to.x - segment.from.x;
  const dy = segment.to.y - segment.from.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(
            0,
            ((sample.x - segment.from.x) * dx + (sample.y - segment.from.y) * dy) / lengthSquared,
          ),
        );
  return Math.hypot(
    sample.x - (segment.from.x + projection * dx),
    sample.y - (segment.from.y + projection * dy),
  );
}

function insidePath(sample: Point, segments: readonly Segment[]): boolean {
  let inside = false;
  for (const { from, to } of segments) {
    const crosses = from.y > sample.y !== to.y > sample.y;
    if (!crosses) continue;
    const intersection = ((to.x - from.x) * (sample.y - from.y)) / (to.y - from.y) + from.x;
    if (sample.x < intersection) inside = !inside;
  }
  return inside;
}

function signedDistance(sample: Point, segments: readonly Segment[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const segment of segments) distance = Math.min(distance, distanceToSegment(sample, segment));
  if (!Number.isFinite(distance)) return -1;
  return insidePath(sample, segments) ? distance : -distance;
}

export function rasterizeGlyph(
  outline: GlyphOutline,
  unitsPerEm: number,
  size = 64,
  padding = 6,
): RasterizedGlyph {
  const segments = flattenGlyphPath(outline.commands);
  const contentSize = Math.max(1, size - padding * 2);
  const pixelsPerUnit = contentSize / Math.max(1, unitsPerEm);
  const paddingUnits = padding / pixelsPerUnit;
  const left = outline.extents.xBearing - paddingUnits;
  const top = outline.extents.yBearing + paddingUnits;
  const right = outline.extents.xBearing + outline.extents.width + paddingUnits;
  const bottom = outline.extents.yBearing + outline.extents.height - paddingUnits;
  const planeWidth = Math.max(1, right - left);
  const planeHeight = Math.max(1, top - bottom);
  const distanceRange = paddingUnits * 0.75;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sample = point(
        left + ((x + 0.5) / size) * planeWidth,
        top - ((y + 0.5) / size) * planeHeight,
      );
      const normalized = Math.min(
        1,
        Math.max(0, 0.5 + signedDistance(sample, segments) / distanceRange),
      );
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(normalized * 255);
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
  }
  return {
    pixels,
    width: size,
    height: size,
    plane: { left, top, right, bottom },
    distanceRange,
  };
}

export class ProductionTextShaper {
  readonly #font: harfbuzz.Font;
  readonly unitsPerEm: number;

  private constructor(font: harfbuzz.Font, unitsPerEm: number) {
    this.#font = font;
    this.unitsPerEm = unitsPerEm;
  }

  static async create(woff2: ArrayBuffer | Uint8Array): Promise<ProductionTextShaper> {
    const sfnt = await decompress(woff2);
    if (sfnt.byteLength > 30 * 1024 * 1024)
      throw new Error("Decompressed caption font is too large");
    const blob = new harfbuzz.Blob(sfnt);
    const face = new harfbuzz.Face(blob);
    const font = new harfbuzz.Font(face);
    font.setScale(face.upem, face.upem);
    return new ProductionTextShaper(font, face.upem);
  }

  shape(text: string, weight = 600): ShapedGlyph[] {
    if (text.length > 10_000) throw new Error("Text shaping input is too large");
    this.#font.setVariations([
      new harfbuzz.Variation("wght", Math.min(900, Math.max(100, weight))),
    ]);
    const buffer = new harfbuzz.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    harfbuzz.shape(this.#font, buffer);
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    return infos.map((info, index) => ({
      glyphId: info.codepoint,
      cluster: info.cluster,
      ...positions[index]!,
    }));
  }

  outline(glyphId: number): GlyphOutline | null {
    const extents = this.#font.glyphExtents(glyphId);
    if (!extents) return null;
    return { glyphId, extents, commands: this.#font.glyphToJson(glyphId) };
  }
}

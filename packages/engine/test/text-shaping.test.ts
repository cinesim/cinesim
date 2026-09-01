import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  flattenGlyphPath,
  ProductionTextShaper,
  rasterizeGlyph,
} from "../src/compositor/text-shaping";

const fontPath = fileURLToPath(
  new URL(
    "../node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
    import.meta.url,
  ),
);

describe("production text shaping", () => {
  it("applies OpenType ligatures and returns positioned glyphs", async () => {
    const shaper = await ProductionTextShaper.create(await readFile(fontPath));
    const shaped = shaper.shape("office");

    expect(shaped.length).toBeLessThan("office".length);
    expect(shaped.every(({ glyphId, xAdvance }) => glyphId > 0 && xAdvance >= 0)).toBe(true);
  });

  it("flattens vector outlines into a bounded signed-distance glyph", async () => {
    const shaper = await ProductionTextShaper.create(await readFile(fontPath));
    const glyph = shaper.shape("S")[0]!;
    const outline = shaper.outline(glyph.glyphId)!;
    const segments = flattenGlyphPath(outline.commands);
    const raster = rasterizeGlyph(outline, shaper.unitsPerEm);

    expect(segments.length).toBeGreaterThan(20);
    expect(raster).toMatchObject({ width: 64, height: 64 });
    expect(raster.pixels).toHaveLength(64 * 64 * 4);
    expect(Math.min(...raster.pixels.filter((_, index) => index % 4 === 0))).toBe(0);
    expect(Math.max(...raster.pixels.filter((_, index) => index % 4 === 0))).toBe(255);
  });
});

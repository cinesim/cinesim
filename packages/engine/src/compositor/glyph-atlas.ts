import captionFontUrl from "@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2?url";
import { ProductionTextShaper, rasterizeGlyph, type ShapedGlyph } from "./text-shaping";

const ATLAS_SIZE = 1024;
const CELL_SIZE = 64;
const CELLS_PER_ROW = ATLAS_SIZE / CELL_SIZE;
const CELLS_PER_PAGE = CELLS_PER_ROW * CELLS_PER_ROW;
const MAX_ATLAS_PAGES = 4;

export interface AtlasGlyph {
  texture: GPUTexture;
  uv: readonly [number, number, number, number];
  plane: { left: number; top: number; right: number; bottom: number };
  distanceRange: number;
}

export interface ShapedAtlasGlyph {
  shaped: ShapedGlyph;
  atlas: AtlasGlyph | null;
}

function normalizedWeight(weight: number): number {
  return Math.min(900, Math.max(100, Math.round(weight / 50) * 50));
}

function atlasCoordinates(index: number): { page: number; column: number; row: number } {
  const page = Math.floor(index / CELLS_PER_PAGE);
  const withinPage = index % CELLS_PER_PAGE;
  return {
    page,
    column: withinPage % CELLS_PER_ROW,
    row: Math.floor(withinPage / CELLS_PER_ROW),
  };
}

export class WebGpuGlyphAtlas {
  readonly #device: GPUDevice;
  readonly #shaper: ProductionTextShaper;
  readonly #pages: GPUTexture[] = [];
  readonly #glyphs = new Map<string, AtlasGlyph | null>();
  #nextCell = 0;

  private constructor(device: GPUDevice, shaper: ProductionTextShaper) {
    this.#device = device;
    this.#shaper = shaper;
  }

  static async create(device: GPUDevice): Promise<WebGpuGlyphAtlas> {
    const response = await fetch(captionFontUrl);
    if (!response.ok) throw new Error(`Caption font could not be loaded (${response.status})`);
    const font = await response.arrayBuffer();
    if (font.byteLength > 2 * 1024 * 1024) throw new Error("Caption font exceeds its size budget");
    return new WebGpuGlyphAtlas(device, await ProductionTextShaper.create(font));
  }

  shape(text: string, weight: number): ShapedAtlasGlyph[] {
    const variation = normalizedWeight(weight);
    return this.#shaper.shape(text, variation).map((shaped) => ({
      shaped,
      atlas: this.#atlasGlyph(shaped.glyphId, variation),
    }));
  }

  get unitsPerEm(): number {
    return this.#shaper.unitsPerEm;
  }

  #atlasGlyph(glyphId: number, weight: number): AtlasGlyph | null {
    const key = `${weight}:${glyphId}`;
    const cached = this.#glyphs.get(key);
    if (cached !== undefined || this.#glyphs.has(key)) return cached ?? null;
    const outline = this.#shaper.outline(glyphId);
    if (!outline || outline.commands.length === 0) {
      this.#glyphs.set(key, null);
      return null;
    }
    if (this.#nextCell >= CELLS_PER_PAGE * MAX_ATLAS_PAGES) return null;
    const raster = rasterizeGlyph(outline, this.#shaper.unitsPerEm, CELL_SIZE);
    const coordinates = atlasCoordinates(this.#nextCell);
    this.#nextCell += 1;
    const texture = this.#page(coordinates.page);
    this.#device.queue.writeTexture(
      {
        texture,
        origin: { x: coordinates.column * CELL_SIZE, y: coordinates.row * CELL_SIZE },
      },
      raster.pixels,
      { bytesPerRow: CELL_SIZE * 4, rowsPerImage: CELL_SIZE },
      { width: CELL_SIZE, height: CELL_SIZE },
    );
    const left = (coordinates.column * CELL_SIZE) / ATLAS_SIZE;
    const top = (coordinates.row * CELL_SIZE) / ATLAS_SIZE;
    const result: AtlasGlyph = {
      texture,
      uv: [left, top, left + CELL_SIZE / ATLAS_SIZE, top + CELL_SIZE / ATLAS_SIZE],
      plane: raster.plane,
      distanceRange: raster.distanceRange,
    };
    this.#glyphs.set(key, result);
    return result;
  }

  #page(index: number): GPUTexture {
    const existing = this.#pages[index];
    if (existing) return existing;
    const texture = this.#device.createTexture({
      label: `cinesim-glyph-atlas-${index}`,
      size: { width: ATLAS_SIZE, height: ATLAS_SIZE },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#pages[index] = texture;
    return texture;
  }

  destroy(): void {
    this.#pages.forEach((texture) => texture.destroy());
    this.#pages.length = 0;
    this.#glyphs.clear();
  }
}

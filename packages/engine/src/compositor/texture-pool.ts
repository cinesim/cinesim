interface TextureEntry {
  texture: GPUTexture;
  width: number;
  height: number;
  format: GPUTextureFormat;
}

export class BoundedRenderTexturePool {
  readonly #entries: TextureEntry[] = [];

  constructor(private readonly maximum = 4) {
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error("Invalid texture-pool bound.");
  }

  acquire(device: GPUDevice, width: number, height: number, format: GPUTextureFormat): GPUTexture {
    const reusable = this.#entries.find(
      (entry) => entry.width === width && entry.height === height && entry.format === format,
    );
    if (reusable) return reusable.texture;
    if (this.#entries.length >= this.maximum) {
      this.#entries.shift()?.texture.destroy();
    }
    const texture = device.createTexture({
      label: "cinesim-render-intermediate",
      size: { width, height },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#entries.push({ texture, width, height, format });
    return texture;
  }

  destroy(): void {
    this.#entries.forEach((entry) => entry.texture.destroy());
    this.#entries.length = 0;
  }

  get size(): number {
    return this.#entries.length;
  }
}

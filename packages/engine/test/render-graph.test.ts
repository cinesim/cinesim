import { describe, expect, it } from "vite-plus/test";
import { BoundedRenderTexturePool, buildRenderGraph } from "@cinesim/engine";

describe("bounded render graph", () => {
  it("preserves deterministic painter order and plans bounded effect lifetimes", () => {
    const graph = buildRenderGraph([
      {
        id: "title",
        kind: "text",
        painterOrder: 20,
        effectCount: 0,
        masked: false,
        groupDepth: 1,
        blendMode: "normal",
      },
      {
        id: "picture",
        kind: "media",
        painterOrder: 10,
        effectCount: 3,
        masked: true,
        groupDepth: 0,
        blendMode: "multiply",
      },
    ]);
    expect(graph.painterOrder).toEqual(["picture", "title"]);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "picture:source",
      "picture:effects",
      "picture:mask",
      "title:source",
      "title:group",
      "scene:composite",
      "scene:output",
    ]);
    expect(graph.nodes.at(-2)?.inputs).toEqual(["picture:mask", "title:group"]);
    expect(graph.intermediateTextureCount).toBe(4);
  });

  it("rejects duplicate semantic layer ids", () => {
    const layer = {
      id: "duplicate",
      kind: "graphic" as const,
      painterOrder: 0,
      effectCount: 0,
      masked: false,
      groupDepth: 0,
      blendMode: "normal",
    };
    expect(() => buildRenderGraph([layer, layer])).toThrow(/Duplicate render-graph layer/);
  });
});

describe("render texture pool", () => {
  it("reuses matching textures and evicts within its hard bound", () => {
    Object.defineProperty(globalThis, "GPUTextureUsage", {
      configurable: true,
      value: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 },
    });
    const destroyed: number[] = [];
    let created = 0;
    const device = {
      createTexture() {
        const id = created++;
        return { destroy: () => destroyed.push(id) };
      },
    } as unknown as GPUDevice;
    const pool = new BoundedRenderTexturePool(2);
    const first = pool.acquire(device, 100, 100, "rgba8unorm");
    expect(pool.acquire(device, 100, 100, "rgba8unorm")).toBe(first);
    pool.acquire(device, 200, 100, "rgba8unorm");
    pool.acquire(device, 300, 100, "rgba8unorm");
    expect(pool.size).toBe(2);
    expect(destroyed).toEqual([0]);
    pool.destroy();
    expect(pool.size).toBe(0);
    expect(destroyed).toEqual([0, 1, 2]);
    Reflect.deleteProperty(globalThis, "GPUTextureUsage");
  });
});

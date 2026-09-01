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

  it("plans a scoped adjustment as one bounded painter operation", () => {
    const layer = (id: string, painterOrder: number) => ({
      id,
      kind: "media" as const,
      painterOrder,
      effectCount: 0,
      masked: false,
      groupDepth: 0,
      blendMode: "normal",
    });
    const graph = buildRenderGraph(
      [layer("background", 0), layer("subject", 1), layer("foreground", 3)],
      [
        {
          id: "grade:scene",
          targetLayerIds: ["subject", "background"],
          painterOrder: 2,
          effectCount: 1,
        },
      ],
    );
    expect(graph.painterOrder).toEqual(["grade:scene", "foreground"]);
    expect(graph.nodes.find((node) => node.id === "grade:scene:group")?.inputs).toEqual([
      "background:source",
      "subject:source",
    ]);
    expect(graph.nodes.at(-2)?.inputs).toEqual(["grade:scene:effects", "foreground:source"]);
    expect(graph.intermediateTextureCount).toBe(4);
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
    expect(pool.acquire(device, 100, 100, "rgba8unorm", "second")).not.toBe(first);
    pool.acquire(device, 300, 100, "rgba8unorm");
    expect(pool.size).toBe(2);
    expect(destroyed).toEqual([0]);
    pool.destroy();
    expect(pool.size).toBe(0);
    expect(destroyed).toEqual([0, 1, 2]);
    Reflect.deleteProperty(globalThis, "GPUTextureUsage");
  });
});

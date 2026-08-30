import { describe, expect, it } from "vite-plus/test";
import type { AssetId } from "@cinesim/core";
import {
  rectangleFromPoints,
  rectanglesIntersect,
  updateAssetSelection,
} from "../src/renderer/components/media/media-bin-model";

const ids = ["asset_a", "asset_b", "asset_c", "asset_d"] satisfies AssetId[];

describe("media bin selection", () => {
  it("normalizes a marquee dragged in any direction", () => {
    expect(rectangleFromPoints({ x: 20, y: 30 }, { x: 5, y: 10 })).toEqual({
      x: 5,
      y: 10,
      width: 15,
      height: 20,
    });
  });

  it("selects only rectangles with overlapping area", () => {
    const marquee = { x: 10, y: 10, width: 20, height: 20 };

    expect(rectanglesIntersect(marquee, { left: 20, top: 20, right: 40, bottom: 40 })).toBe(true);
    expect(rectanglesIntersect(marquee, { left: 30, top: 10, right: 40, bottom: 20 })).toBe(false);
  });

  it("selects the visible range between the anchor and target", () => {
    const result = updateAssetSelection(new Set([ids[1]!]), ids, ids[3]!, ids[1]!, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    });

    expect([...result.selectedIds]).toEqual(ids.slice(1));
    expect(result.anchor).toBe(ids[1]);
  });

  it("toggles an asset with either platform modifier", () => {
    const added = updateAssetSelection(new Set([ids[0]!]), ids, ids[1]!, ids[0]!, {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    });
    const removed = updateAssetSelection(added.selectedIds, ids, ids[0]!, added.anchor, {
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    });

    expect([...added.selectedIds]).toEqual(ids.slice(0, 2));
    expect([...removed.selectedIds]).toEqual([ids[1]]);
  });

  it("falls back to a single selection when a range anchor is filtered out", () => {
    const result = updateAssetSelection(new Set([ids[0]!]), ids.slice(1), ids[2]!, ids[0]!, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    });

    expect([...result.selectedIds]).toEqual([ids[2]]);
    expect(result.anchor).toBe(ids[2]);
  });
});

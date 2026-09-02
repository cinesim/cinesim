import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const mediaDirectory = join(import.meta.dirname, "../src/renderer/components/media");

describe("shared media presentation", () => {
  it("keeps cards, rows, and workspace actions on shared components", async () => {
    const [grid, list, editPool, presentation] = await Promise.all(
      [
        "media-bin-grid.tsx",
        "media-bin-list.tsx",
        "edit-media-pool.tsx",
        "media-asset-presentation.tsx",
      ].map((file) => readFile(join(mediaDirectory, file), "utf8")),
    );

    expect(grid).toContain("<MediaAssetCard");
    expect(list).toContain("<MediaAssetRow");
    expect(editPool).toContain("<MediaAssetCard");
    expect(editPool).toContain("<MediaAssetContextMenu");
    expect(grid).not.toContain("<MediaSkimSurface");
    expect(list).not.toContain("<MediaSkimSurface");
    expect(editPool).not.toContain("<PreviewCard");
    expect(presentation).toContain("<MediaTranscriptBadge");
  });
});

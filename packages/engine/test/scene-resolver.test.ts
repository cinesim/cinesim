import { describe, expect, it } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import { resolveScene } from "../src/playback/scene-resolver";

const asset: Asset = {
  id: "asset_layer",
  kind: "video",
  name: "Layer.mov",
  source: { kind: "local", path: "/media/layer.mov" },
  durationUs: 1_000_000,
};

describe("timeline visual layer order", () => {
  it("resolves lower tracks first so index zero composites uppermost", () => {
    let project = applyCommand(createProject({ name: "Layers" }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "overlay",
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      assetId: asset.id,
      timelineStartUs: 0,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000003",
      assetId: asset.id,
      timelineStartUs: 0,
    }).project;

    expect(resolveScene(project, 500_000).map((layer) => layer.track.id)).toEqual([
      "track_000003",
      "track_000001",
    ]);
  });
});

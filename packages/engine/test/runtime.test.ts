import { describe, expect, it } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import {
  LatestRequestController,
  MonotonicPlaybackClock,
  resolveScene,
  sparseSampleTimes,
} from "../src";

const asset: Asset = {
  id: "asset_000001",
  kind: "video",
  name: "shot.mp4",
  source: { kind: "local", path: "/shot.mp4" },
  durationUs: 5_000_000,
};

describe("timeline runtime primitives", () => {
  it("maps active clips to source time", () => {
    let project = applyCommand(createProject({ name: "Runtime" }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: project.sequences[0]!.tracks[0]!.id,
      assetId: asset.id,
      timelineStartUs: 2_000_000,
      sourceStartUs: 1_000_000,
      sourceEndUs: 4_000_000,
    }).project;
    expect(resolveScene(project, 2_500_000)[0]!.sourceTimeUs).toBe(1_500_000);
    expect(resolveScene(project, 5_000_000)).toHaveLength(0);
  });

  it("uses monotonic runtime time instead of frame increments", () => {
    let nowMs = 100;
    const clock = new MonotonicPlaybackClock(() => nowMs);
    clock.seek(2_000_000);
    clock.play();
    nowMs = 350;
    expect(clock.now()).toBe(2_250_000);
    clock.pause();
    nowMs = 900;
    expect(clock.now()).toBe(2_250_000);
  });

  it("drops obsolete seek results", async () => {
    const resolvers = new Map<number, (value: number) => void>();
    const controller = new LatestRequestController<number, number>(
      (value) => new Promise((resolve) => resolvers.set(value, resolve)),
    );
    const first = controller.run(1);
    const second = controller.run(2);
    resolvers.get(1)!(1);
    resolvers.get(2)!(2);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe(2);
  });

  it("builds bounded sparse sample times", () => {
    expect(sparseSampleTimes(12_000_000, 5_000_000)).toEqual([
      0, 5_000_000, 10_000_000, 11_999_999,
    ]);
  });
});

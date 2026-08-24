import { describe, expect, it } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import {
  LatestRequestController,
  LatestOnlyExecutor,
  MonotonicPlaybackClock,
  filmstripSampleTimes,
  nearestSampleIndex,
  pointerSourceTimeUs,
  resolveScene,
  scoreThumbnailRgba,
  sparseSampleTimes,
  thumbnailCandidateTimes,
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

describe("LatestOnlyExecutor", () => {
  it("runs one operation and keeps only the newest pending request", async () => {
    const started: number[] = [];
    const resolvers: Array<() => void> = [];
    const executor = new LatestOnlyExecutor<number, number>(async (value) => {
      started.push(value);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return value;
    });

    const first = executor.run(1);
    const second = executor.run(2);
    const third = executor.run(3);
    expect(started).toEqual([1]);
    expect(await second).toBeUndefined();
    resolvers.shift()!();
    expect(await first).toBeUndefined();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(started).toEqual([1, 3]);
    resolvers.shift()!();
    expect(await third).toBe(3);
    expect(executor.metrics).toMatchObject({ received: 3, coalesced: 1, obsolete: 1 });
  });

  it("invalidates side effects and recovers after failures", async () => {
    const effects: number[] = [];
    let release: (() => void) | undefined;
    const executor = new LatestOnlyExecutor<number, void>(async (value, context) => {
      if (value === 1) await new Promise<void>((resolve) => (release = resolve));
      if (value === 2) throw new Error("expected");
      if (context.isCurrent()) effects.push(value);
    });

    const obsolete = executor.run(1);
    executor.invalidate();
    release!();
    await obsolete;
    await expect(executor.run(2)).rejects.toThrow("expected");
    await executor.run(3);
    expect(effects).toEqual([3]);
    expect(executor.metrics).toMatchObject({ obsolete: 1, failed: 1, completed: 1 });
  });
});

describe("derived perception primitives", () => {
  it("maps pointer coordinates to clamped source time", () => {
    expect(pointerSourceTimeUs(50, 100, 200, 1_000)).toBe(0);
    expect(pointerSourceTimeUs(200, 100, 200, 1_000)).toBe(500);
    expect(pointerSourceTimeUs(400, 100, 200, 1_000)).toBe(999);
  });

  it("keeps filmstrip sampling bounded and deterministic", () => {
    const times = filmstripSampleTimes(3_600_000_000);
    expect(times).toHaveLength(32);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBe(3_599_999_999);
    expect(nearestSampleIndex([0, 100, 200], 149)).toBe(1);
    expect(nearestSampleIndex([0, 100, 200], 151)).toBe(2);
  });

  it("scores useful thumbnail candidates and rejects flat frames", () => {
    const flat = new Uint8ClampedArray(4 * 4 * 4).fill(0);
    const detailed = new Uint8ClampedArray(4 * 4 * 4);
    for (let index = 0; index < detailed.length; index += 4) {
      const value = (index / 4) % 2 ? 230 : 30;
      detailed[index] = value;
      detailed[index + 1] = value;
      detailed[index + 2] = value;
      detailed[index + 3] = 255;
    }
    expect(scoreThumbnailRgba(flat, 4, 4, 500, 1_000).rejected).toBe(true);
    expect(scoreThumbnailRgba(detailed, 4, 4, 500, 1_000).score).toBeGreaterThan(0);
    expect(thumbnailCandidateTimes(60_000_000)).toHaveLength(12);
    expect(thumbnailCandidateTimes(60_000_000)).toEqual(thumbnailCandidateTimes(60_000_000));
  });
});

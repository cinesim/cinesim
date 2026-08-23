import { describe, expect, it } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import {
  LatestRequestController,
  LatestOnlyExecutor,
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

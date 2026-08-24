import { describe, expect, it } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import {
  LatestRequestController,
  LatestOnlyExecutor,
  LAYER_UNIFORM_BYTE_SIZE,
  MonotonicPlaybackClock,
  filmstripSampleTimes,
  nearestSampleIndex,
  pointerSourceTimeUs,
  packLayerUniform,
  PlaybackRuntime,
  evaluateAdaptivePolicy,
  resolveScene,
  scoreThumbnailRgba,
  sparseSampleTimes,
  thumbnailCandidateTimes,
} from "../src";
import type { CompositorLayer, PreviewCompositor, VideoSourceFactory } from "../src";

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

  it("anchors signed rate changes without introducing a time discontinuity", () => {
    let nowMs = 0;
    const clock = new MonotonicPlaybackClock(() => nowMs);
    clock.seek(1_000_000);
    clock.play();
    nowMs = 100;
    clock.setRate(2);
    expect(clock.now()).toBe(1_100_000);
    nowMs = 200;
    expect(clock.now()).toBe(1_300_000);
    clock.setRate(-1);
    nowMs = 300;
    expect(clock.now()).toBe(1_200_000);
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

describe("WebGPU compositor uniforms", () => {
  it("packs two aligned vec4 values into the declared 32-byte binding", () => {
    const uniform = packLayerUniform(
      {
        x: 0.25,
        y: -0.5,
        scaleX: 1.5,
        scaleY: 0.75,
        opacity: 0.5,
        fit: "contain",
      },
      0.5,
      0.5,
    );

    expect(uniform.byteLength).toBe(LAYER_UNIFORM_BYTE_SIZE);
    expect([...uniform]).toEqual([0.25, 0.5, 0.75, 0.375, 0.5, 0, 0, 0]);
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

describe("PlaybackRuntime source preview", () => {
  it("keeps timeline time unchanged and restores its frame after asset preview", async () => {
    let project = applyCommand(createProject({ name: "Preview" }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: project.sequences[0]!.tracks[0]!.id,
      assetId: asset.id,
      timelineStartUs: 0,
    }).project;
    const renderedTimes: number[] = [];
    const compositor: PreviewCompositor = {
      initialize: async () => undefined,
      render: (layers: CompositorLayer[]) => {
        for (const layer of layers) {
          renderedTimes.push((layer.frame as VideoFrame & { sourceTimeUs: number }).sourceTimeUs);
          layer.frame.close();
        }
      },
      metrics: {
        gpuSubmitCpuMs: 0,
        submittedFrames: 0,
        activeFrames: 0,
        deviceLostCount: 0,
        outputWidth: 1920,
        outputHeight: 1080,
      },
      destroy: () => undefined,
    };
    const sourceFactory: VideoSourceFactory = () => ({
      prepare: async () => ({
        durationUs: asset.durationUs,
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: false,
      }),
      seek: async () => undefined,
      getFrame: async (sourceTimeUs) =>
        ({
          sourceTimeUs,
          displayWidth: 1920,
          displayHeight: 1080,
          close: () => undefined,
        }) as unknown as VideoFrame,
      destroy: () => undefined,
    });
    const runtime = new PlaybackRuntime(project, compositor, { sourceFactory, now: () => 0 });
    await runtime.initialize();
    await runtime.seekTimeline(1_000_000);
    runtime.enterAssetPreview(asset.id, 4_000_000);
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    const unsubscribe = runtime.subscribe((value) => {
      expect(value.timeUs).toBe(1_000_000);
      expect(value.mode.kind).toBe("asset");
    });
    unsubscribe();
    await runtime.exitAssetPreview();
    expect(renderedTimes).toEqual([0, 1_000_000, 4_000_000, 1_000_000]);
    runtime.destroy();
  });

  it("reports rejected background preview work through the runtime error hook", async () => {
    const project = applyCommand(createProject({ name: "Preview errors" }), {
      type: "asset.import",
      asset,
    }).project;
    const compositor: PreviewCompositor = {
      initialize: async () => undefined,
      render: (layers) => layers.forEach((layer) => layer.frame.close()),
      metrics: {
        gpuSubmitCpuMs: 0,
        submittedFrames: 0,
        activeFrames: 0,
        deviceLostCount: 0,
        outputWidth: 1920,
        outputHeight: 1080,
      },
      destroy: () => undefined,
    };
    const expected = new Error("preview decode failed");
    const reported: Error[] = [];
    const runtime = new PlaybackRuntime(project, compositor, {
      sourceFactory: () => ({
        prepare: async () => ({
          durationUs: asset.durationUs,
          width: 1920,
          height: 1080,
          frameRate: 30,
          hasAudio: false,
        }),
        seek: async () => undefined,
        getFrame: async () => {
          throw expected;
        },
        destroy: () => undefined,
      }),
      onError: (error) => reported.push(error),
    });

    await runtime.initialize();
    runtime.enterAssetPreview(asset.id, 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(reported).toEqual([expected]);
    runtime.destroy();
  });
});

describe("PlaybackRuntime transport", () => {
  const flush = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  function timelineProject() {
    let project = applyCommand(createProject({ name: "Transport", frameRate: 30 }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: project.sequences[0]!.tracks[0]!.id,
      assetId: asset.id,
      timelineStartUs: 0,
    }).project;
    return project;
  }

  function frame(sourceTimeUs: number, onClose: () => void = () => undefined): VideoFrame {
    const create = (): VideoFrame =>
      ({
        sourceTimeUs,
        timestamp: sourceTimeUs,
        duration: 33_333,
        displayWidth: 1920,
        displayHeight: 1080,
        clone: create,
        close: onClose,
      }) as unknown as VideoFrame;
    return create();
  }

  function compositor(renderedTimes: number[]): PreviewCompositor {
    return {
      initialize: async () => undefined,
      render: (layers) => {
        for (const layer of layers) {
          renderedTimes.push((layer.frame as VideoFrame & { sourceTimeUs: number }).sourceTimeUs);
          layer.frame.close();
        }
      },
      metrics: {
        gpuSubmitCpuMs: 0,
        submittedFrames: 0,
        activeFrames: 0,
        deviceLostCount: 0,
        outputWidth: 1920,
        outputHeight: 1080,
      },
      destroy: () => undefined,
    };
  }

  it("presents slow playback decodes instead of invalidating one on every display refresh", async () => {
    let nowMs = 0;
    let nextFrameHandle = 0;
    const scheduled = new Map<number, () => void>();
    const playbackDecodes: Array<{ timeUs: number; resolve: (value: VideoFrame) => void }> = [];
    let decodeCount = 0;
    const renderedTimes: number[] = [];
    const runtime = new PlaybackRuntime(timelineProject(), compositor(renderedTimes), {
      now: () => nowMs,
      scheduleFrame: (callback) => {
        const handle = ++nextFrameHandle;
        scheduled.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => scheduled.delete(handle),
      sourceFactory: () => ({
        prepare: async () => ({
          durationUs: asset.durationUs,
          width: 1920,
          height: 1080,
          frameRate: 30,
          hasAudio: false,
        }),
        seek: async () => undefined,
        getFrame: async (timeUs) => {
          decodeCount += 1;
          if (decodeCount === 1) return frame(timeUs);
          return new Promise<VideoFrame>((resolve) => playbackDecodes.push({ timeUs, resolve }));
        },
        destroy: () => undefined,
      }),
    });
    await runtime.initialize();

    runtime.play();
    await flush();
    expect(playbackDecodes).toHaveLength(1);
    expect(scheduled).toHaveLength(0);

    // A 100 ms decoder spans six 60 Hz display refreshes. There is still only
    // one request in flight, and its result remains eligible for presentation.
    nowMs = 100;
    playbackDecodes.shift()!.resolve(frame(0));
    await flush();
    expect(renderedTimes).toEqual([0, 0]);
    expect(scheduled).toHaveLength(1);

    const callback = scheduled.values().next().value!;
    scheduled.clear();
    callback();
    await flush();
    expect(playbackDecodes[0]!.timeUs).toBe(100_000);
    nowMs = 200;
    playbackDecodes.shift()!.resolve(frame(100_000));
    await flush();

    let snapshot!: Parameters<Parameters<typeof runtime.subscribe>[0]>[0];
    const unsubscribe = runtime.subscribe((value) => (snapshot = value));
    unsubscribe();
    expect(snapshot.framesPresented).toBe(3);
    expect(snapshot.framesObsolete).toBe(0);
    expect(snapshot.droppedFrames).toBe(2);
    runtime.destroy();
  });

  it("uses a bounded sequential cursor during forward playback", async () => {
    let nowMs = 0;
    let callback: (() => void) | undefined;
    let randomReads = 0;
    let sequentialStarts = 0;
    let retainedFrames = 0;
    const renderedTimes: number[] = [];
    const trackedFrame = (timeUs: number): VideoFrame => {
      retainedFrames += 1;
      let closed = false;
      return {
        sourceTimeUs: timeUs,
        timestamp: timeUs,
        duration: 33_333,
        displayWidth: 1920,
        displayHeight: 1080,
        clone: () => trackedFrame(timeUs),
        close: () => {
          if (closed) return;
          closed = true;
          retainedFrames -= 1;
        },
      } as unknown as VideoFrame;
    };
    const runtime = new PlaybackRuntime(timelineProject(), compositor(renderedTimes), {
      now: () => nowMs,
      scheduleFrame: (next) => {
        callback = next;
        return 1;
      },
      cancelFrame: () => {
        callback = undefined;
      },
      sourceFactory: () => ({
        prepare: async () => ({
          durationUs: asset.durationUs,
          width: 1920,
          height: 1080,
          frameRate: 30,
          hasAudio: false,
        }),
        seek: async () => undefined,
        getFrame: async (timeUs) => {
          randomReads += 1;
          return trackedFrame(timeUs);
        },
        frames: async function* (fromUs) {
          sequentialStarts += 1;
          for (let timeUs = fromUs; timeUs < asset.durationUs; timeUs += 33_333)
            yield trackedFrame(timeUs);
        },
        destroy: () => undefined,
      }),
    });
    await runtime.initialize();
    runtime.play();
    await flush();
    nowMs = 34;
    const next = callback!;
    callback = undefined;
    next();
    await flush();

    expect(randomReads).toBe(2); // Initial render plus cursor bootstrap.
    expect(sequentialStarts).toBe(1);
    expect(renderedTimes.at(-1)).toBe(33_333);
    expect(retainedFrames).toBeLessThanOrEqual(2);
    runtime.destroy();
    await flush();
    expect(retainedFrames).toBe(0);
  });

  it("steps exact sequence frames and exposes bounded J/K/L shuttle rates", async () => {
    let snapshot!: Parameters<Parameters<PlaybackRuntime["subscribe"]>[0]>[0];
    const runtime = new PlaybackRuntime(timelineProject(), compositor([]), {
      now: () => 0,
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      sourceFactory: () => ({
        prepare: async () => ({
          durationUs: asset.durationUs,
          width: 1920,
          height: 1080,
          frameRate: 30,
          hasAudio: false,
        }),
        seek: async () => undefined,
        getFrame: async (timeUs) => frame(timeUs),
        destroy: () => undefined,
      }),
    });
    await runtime.initialize();
    await runtime.seekTimeline(1_000_000);
    await runtime.stepFrames(1);
    const unsubscribe = runtime.subscribe((value) => (snapshot = value));
    expect(snapshot.timeUs).toBe(1_033_333);

    runtime.shuttle(1);
    runtime.shuttle(1);
    runtime.shuttle(1);
    runtime.shuttle(1);
    runtime.shuttle(1);
    expect(snapshot.playbackRate).toBe(8);
    runtime.shuttle(-1);
    expect(snapshot.playbackRate).toBe(-1);
    runtime.shuttle(0);
    expect(snapshot.playbackRate).toBe(0);
    unsubscribe();
    runtime.destroy();
  });
});

describe("adaptive media policy", () => {
  const healthy = {
    observations: 5,
    warmSeekP95Ms: 80,
    deadlineMissRate: 0.01,
    requestsReceived: 10,
    requestsCoalesced: 0,
    proxyState: "missing" as const,
    diskHeadroomAvailable: true,
  };

  it("waits for meaningful observations and leaves healthy originals alone", () => {
    expect(evaluateAdaptivePolicy({ ...healthy, observations: 4 }).decision).toBe("observing");
    expect(evaluateAdaptivePolicy(healthy)).toEqual({
      decision: "original-sufficient",
      reasons: ["original-sufficient"],
      queueProxy: false,
    });
  });

  it("queues unhealthy sources with explicit reasons and applies hysteresis", () => {
    expect(
      evaluateAdaptivePolicy({
        ...healthy,
        warmSeekP95Ms: 180,
        deadlineMissRate: 0.08,
        requestsCoalesced: 3,
      }),
    ).toMatchObject({
      decision: "proxy-queued",
      queueProxy: true,
      reasons: [
        "warm-seek-p95-over-budget",
        "playback-deadline-miss-rate",
        "request-backlog-sustained",
      ],
    });
    expect(evaluateAdaptivePolicy({ ...healthy, proxyState: "ready" }).decision).toBe(
      "proxy-ready",
    );
  });

  it("does not queue a proxy without disk headroom", () => {
    expect(
      evaluateAdaptivePolicy({ ...healthy, warmSeekP95Ms: 200, diskHeadroomAvailable: false }),
    ).toMatchObject({
      decision: "observing",
      queueProxy: false,
      reasons: ["warm-seek-p95-over-budget", "insufficient-disk-headroom"],
    });
  });
});

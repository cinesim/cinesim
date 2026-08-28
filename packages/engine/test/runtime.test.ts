import { describe, expect, it } from "vite-plus/test";
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
  resolveScene,
  scoreThumbnailRgba,
  sparseSampleTimes,
  thumbnailCandidateTimes,
} from "../src";
import type {
  CompositorLayer,
  PlaybackAudioScheduler,
  PreviewCompositor,
  VideoSourceFactory,
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

  it("publishes source mode before its first frame finishes decoding", async () => {
    const project = applyCommand(createProject({ name: "Preview state" }), {
      type: "asset.import",
      asset,
    }).project;
    let finishDecode!: (frame: VideoFrame) => void;
    let notifyDecodeStarted!: () => void;
    const decodeStarted = new Promise<void>((resolve) => (notifyDecodeStarted = resolve));
    const runtime = new PlaybackRuntime(
      project,
      {
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
      },
      {
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
            notifyDecodeStarted();
            return new Promise<VideoFrame>((resolve) => (finishDecode = resolve));
          },
          destroy: () => undefined,
        }),
      },
    );
    await runtime.initialize();
    const modes: string[] = [];
    const unsubscribe = runtime.subscribe((snapshot) => modes.push(snapshot.mode.kind));

    runtime.enterAssetPreview(asset.id, 1_000_000);

    expect(modes.at(-1)).toBe("asset");
    await decodeStarted;
    finishDecode({ close: () => undefined } as VideoFrame);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    unsubscribe();
    runtime.destroy();
  });
});

describe("PlaybackRuntime transport", () => {
  const flush = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  function timelineProject(projectAsset: Asset = asset) {
    let project = applyCommand(createProject({ name: "Transport", frameRate: 30 }), {
      type: "asset.import",
      asset: projectAsset,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: project.sequences[0]!.tracks[0]!.id,
      assetId: projectAsset.id,
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

  it("presents a covering frame without waiting for a future sequential sample", async () => {
    let callback: (() => void) | undefined;
    let futurePulls = 0;
    const renderedTimes: number[] = [];
    const runtime = new PlaybackRuntime(timelineProject(), compositor(renderedTimes), {
      now: () => 0,
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
        getFrame: async (timeUs) => frame(timeUs),
        frames: async function* () {
          futurePulls += 1;
          await new Promise<void>(() => undefined);
          yield frame(33_333);
        },
        destroy: () => undefined,
      }),
    });
    await runtime.initialize();
    runtime.play();
    await flush();

    expect(renderedTimes).toEqual([0, 0]);
    expect(futurePulls).toBe(0);
    expect(callback).toBeTypeOf("function");
    runtime.destroy();
  });

  it("keeps only the newest playing seek and restarts audio at its exact position", async () => {
    const audibleAsset: Asset = { ...asset, hasAudio: true };
    const renderedTimes: number[] = [];
    const audioStarts: number[] = [];
    let audioStops = 0;
    const audioScheduler: PlaybackAudioScheduler = {
      startTransport: (timeUs) => audioStarts.push(timeUs),
      schedule: async () => undefined,
      resume: async () => undefined,
      stop: () => {
        audioStops += 1;
      },
      destroy: async () => undefined,
    };
    const pending = new Map<number, (value: VideoFrame) => void>();
    const deferred = new Set<number>();
    let deferSeeks = false;
    const runtime = new PlaybackRuntime(timelineProject(audibleAsset), compositor(renderedTimes), {
      now: () => 0,
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      audioSchedulerFactory: () => audioScheduler,
      sourceFactory: () => ({
        prepare: async () => ({
          durationUs: audibleAsset.durationUs,
          width: 1920,
          height: 1080,
          frameRate: 30,
          hasAudio: true,
        }),
        seek: async () => undefined,
        getFrame: async (timeUs) => {
          if (
            deferSeeks &&
            (timeUs === 1_000_000 || timeUs === 2_000_000) &&
            !deferred.has(timeUs)
          ) {
            deferred.add(timeUs);
            return new Promise<VideoFrame>((resolve) => pending.set(timeUs, resolve));
          }
          return frame(timeUs);
        },
        buffers: async function* () {
          // An empty stream is enough to exercise transport ownership.
        },
        destroy: () => undefined,
      }),
    });
    await runtime.initialize();
    runtime.play();
    await flush();
    expect(audioStarts).toEqual([0]);

    deferSeeks = true;
    const first = runtime.seekTimeline(1_000_000);
    const second = runtime.seekTimeline(2_000_000);
    expect(audioStops).toBeGreaterThan(1);
    pending.get(1_000_000)!(frame(1_000_000));
    await flush();
    expect(audioStarts).toEqual([0]);
    pending.get(2_000_000)!(frame(2_000_000));
    await Promise.all([first, second]);
    await flush();

    expect(audioStarts).toEqual([0, 2_000_000]);
    expect(renderedTimes).not.toContain(1_000_000);
    expect(renderedTimes.at(-1)).toBe(2_000_000);
    runtime.destroy();
  });

  it("uses the selected proxy source for both picture and audio", async () => {
    const audibleAsset: Asset = { ...asset, hasAudio: true };
    const openedUrls: string[] = [];
    let scheduleCalls = 0;
    const audioScheduler: PlaybackAudioScheduler = {
      startTransport: () => undefined,
      schedule: async () => {
        scheduleCalls += 1;
      },
      resume: async () => undefined,
      stop: () => undefined,
      destroy: async () => undefined,
    };
    const pairedProject = applyCommand(createProject({ name: "Paired transport", frameRate: 30 }), {
      type: "asset.import",
      asset: audibleAsset,
    }).project;
    const project = applyCommand(pairedProject, {
      type: "clip.add",
      trackId: pairedProject.sequences[0]!.tracks[0]!.id,
      audioTrackId: pairedProject.sequences[0]!.tracks[1]!.id,
      assetId: audibleAsset.id,
      timelineStartUs: 0,
    }).project;
    const runtime = new PlaybackRuntime(project, compositor([]), {
      now: () => 0,
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      audioSchedulerFactory: () => audioScheduler,
      sourceResolver: {
        resolve: (assetId) => ({
          assetId,
          kind: "proxy",
          url: "cinesim-media://proxy/scoped/asset_000001",
        }),
        resolveOriginal: (assetId) => ({
          assetId,
          kind: "original",
          url: "cinesim-media://asset/scoped/asset_000001?epoch=current",
        }),
      },
      sourceFactory: (descriptor) => {
        openedUrls.push(descriptor.url);
        return {
          prepare: async () => ({
            durationUs: audibleAsset.durationUs,
            width: 1920,
            height: 1080,
            frameRate: 30,
            hasAudio: true,
          }),
          seek: async () => undefined,
          getFrame: async (timeUs) => frame(timeUs),
          buffers: async function* () {
            // The URL selection occurs before scheduling begins.
          },
          destroy: () => undefined,
        };
      },
    });

    await runtime.initialize();
    runtime.play();
    await flush();

    expect(openedUrls).toContain("cinesim-media://proxy/scoped/asset_000001");
    expect(openedUrls).not.toContain("cinesim-media://asset/scoped/asset_000001?epoch=current");
    expect(openedUrls).not.toContain("cinesim-media://asset/asset_000001");
    expect(scheduleCalls).toBe(1);
    runtime.destroy();
  });

  it("closes a slow sequential bootstrap frame when playback is paused", async () => {
    let resolveBootstrap!: (frame: VideoFrame) => void;
    let reads = 0;
    let retainedFrames = 0;
    const trackedFrame = (timeUs: number): VideoFrame => {
      retainedFrames += 1;
      let closed = false;
      return {
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
      } as VideoFrame;
    };
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
        getFrame: async (timeUs) => {
          reads += 1;
          if (reads === 1) return trackedFrame(timeUs);
          return new Promise<VideoFrame>((resolve) => (resolveBootstrap = resolve));
        },
        frames: async function* () {
          yield* [] as VideoFrame[];
          throw new Error("A canceled bootstrap must not open a sequential iterator");
        },
        destroy: () => undefined,
      }),
    });
    await runtime.initialize();
    expect(retainedFrames).toBe(0);
    runtime.play();
    await flush();
    runtime.pause();
    resolveBootstrap(trackedFrame(0));
    await flush();

    expect(retainedFrames).toBe(0);
    runtime.destroy();
  });

  it("clamps paused transport when a project edit shortens the sequence", async () => {
    const project = timelineProject();
    const runtime = new PlaybackRuntime(project, compositor([]), {
      now: () => 0,
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
    await runtime.seekTimeline(4_000_000);
    const clipId = project.sequences[0]!.tracks[0]!.clips[0]!.id;
    const shortened = applyCommand(project, {
      type: "clip.trimEnd",
      clipId,
      atUs: 1_000_000,
    }).project;

    let snapshot!: Parameters<Parameters<PlaybackRuntime["subscribe"]>[0]>[0];
    const unsubscribe = runtime.subscribe((value) => (snapshot = value));
    runtime.setProject(shortened);
    expect(snapshot.timeUs).toBe(1_000_000);
    await flush();
    unsubscribe();
    expect(snapshot.timeUs).toBe(1_000_000);
    expect(snapshot.mode).toEqual({ kind: "timeline", timeUs: 1_000_000 });
    runtime.destroy();
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

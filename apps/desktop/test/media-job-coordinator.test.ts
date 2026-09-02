import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { timeUs } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import {
  applyCommand,
  createProject,
  projectToIr,
} from "../../../packages/core/test/project-fixtures";
import type {
  DerivedMediaSnapshot,
  DesktopApi,
  FinalizeDerivedWrite,
} from "../src/shared/contracts";
import type { TranscriptSnapshot } from "../src/shared/transcript";
import type {
  DerivedWorkerRequest,
  DerivedWorkerResponse,
} from "../src/renderer/lib/derived-worker-api";
import { MediaJobCoordinator } from "../src/renderer/lib/media-job-coordinator";
import {
  WAVEFORM_FORMAT_VERSION,
  waveformByteLength,
  waveformPeakCount,
} from "../src/shared/waveform-format";

const projectScope = {
  cacheKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
  epoch: "00000000-0000-4000-8000-000000000001",
};

class FakeWorker {
  static instance: FakeWorker | null = null;
  static readonly instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<DerivedWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: DerivedWorkerRequest[] = [];

  constructor() {
    FakeWorker.instance = this;
    FakeWorker.instances.push(this);
  }

  postMessage(message: DerivedWorkerRequest): void {
    this.sent.push(message);
  }

  emit(message: DerivedWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<DerivedWorkerResponse>);
  }

  terminate(): void {}
}

function project(hasAudio = false): Project {
  return applyCommand(createProject({ name: "Coordinator" }), {
    type: "asset.import",
    asset: {
      id: "asset_fixture",
      kind: "video",
      name: "fixture.mp4",
      source: { kind: "local", path: "/tmp/fixture.mp4" },
      durationUs: timeUs(2_000_000),
      width: 1280,
      height: 720,
      hasAudio,
    },
  }).project;
}

function snapshot(
  thumbnail: "queued" | "ready" = "queued",
  filmstrip: "queued" | "ready" = "queued",
  waveform: "missing" | "queued" | "ready" = "missing",
): DerivedMediaSnapshot {
  const state = (value: "queued" | "ready") =>
    value === "ready" ? ({ state: value, bytes: 100 } as const) : ({ state: value } as const);
  return {
    version: 1,
    generatorVersion: "3",
    projectScope,
    assets: {
      asset_fixture: {
        assetId: "asset_fixture",
        fingerprintStatus: "current",
        thumbnail:
          thumbnail === "ready"
            ? { ...state(thumbnail), sourceTimeUs: timeUs(500_000) }
            : state(thumbnail),
        filmstrip: state(filmstrip),
        waveform: waveform === "missing" ? { state: "missing" } : state(waveform),
        proxy: { state: "missing" },
        performance: {
          original: {
            observations: 0,
            requestsReceived: 0,
            requestsCoalesced: 0,
            framesPresented: 0,
            framesObsolete: 0,
          },
        },
      },
    },
    storage: {
      totalBytes: 0,
      budgetBytes: 1_000,
      safetyReserveBytes: 100,
      thumbnailBytes: 0,
      filmstripBytes: 0,
      waveformBytes: 0,
      proxyBytes: 0,
      evictionCount: 0,
    },
    jobs: { queued: 2, running: 0, completed: 0, failed: 0 },
    runtime: {
      protocol: {
        requests: 0,
        rangeRequests: 0,
        bytesRead: 0,
        averageLatencyMs: 0,
        errors: 0,
      },
    },
    decisionLog: [],
  };
}

function setup(initial: DerivedMediaSnapshot, initialTranscripts?: TranscriptSnapshot) {
  const current = structuredClone(initial);
  let derivedMediaListener: ((snapshot: DerivedMediaSnapshot) => void) | null = null;
  let transcriptListener: ((snapshot: TranscriptSnapshot) => void) | null = null;
  let frameListener:
    | ((request: import("../src/shared/contracts").FrameRenderRequest) => void)
    | null = null;
  let frameCancelListener: ((request: { requestId: string }) => void) | null = null;
  let visualAnalysisListener:
    | ((request: import("../src/shared/contracts").VisualAnalysisRequest) => void)
    | null = null;
  let visualAnalysisCancelListener: ((request: { requestId: string }) => void) | null = null;
  let exportListener:
    | ((request: import("../src/shared/contracts").ExportRenderRequest) => void)
    | null = null;
  let exportCancelListener: ((request: { jobId: string }) => void) | null = null;
  const transcriptSnapshot: TranscriptSnapshot =
    initialTranscripts ??
    ({
      projectDirectory: "/tmp/project",
      projectScope,
      assets: {},
    } satisfies TranscriptSnapshot);
  const finalized: { writerId: string; result: FinalizeDerivedWrite }[] = [];
  const transcribedChunks: unknown[] = [];
  const finalizedTranscriptJobs: string[] = [];
  const requestedTranscriptAssets: string[][] = [];
  const failTranscriptJob = vi.fn(async () => transcriptSnapshot);
  const begun: { assetId: string; kind: string; expectedBytes?: number }[] = [];
  const canceled: { writerId: string; failureCode?: string; detail?: string }[] = [];
  const completeFrame = vi.fn(async () => undefined);
  const completeVisualAnalysis = vi.fn(async () => undefined);
  const completeExport = vi.fn(async () => undefined);
  const failExport = vi.fn(async () => undefined);
  const api = {
    exports: {
      complete: completeExport,
      fail: failExport,
      onRequested: vi.fn((listener) => {
        exportListener = listener;
        return () => {
          exportListener = null;
        };
      }),
      onCanceled: vi.fn((listener) => {
        exportCancelListener = listener;
        return () => {
          exportCancelListener = null;
        };
      }),
    },
    frames: {
      complete: completeFrame,
      fail: vi.fn(async () => undefined),
      onRequested: vi.fn((listener) => {
        frameListener = listener;
        return () => {
          frameListener = null;
        };
      }),
      onCanceled: vi.fn((listener) => {
        frameCancelListener = listener;
        return () => {
          frameCancelListener = null;
        };
      }),
    },
    visualAnalysis: {
      complete: completeVisualAnalysis,
      fail: vi.fn(async () => undefined),
      onRequested: vi.fn((listener) => {
        visualAnalysisListener = listener;
        return () => {
          visualAnalysisListener = null;
        };
      }),
      onCanceled: vi.fn((listener) => {
        visualAnalysisCancelListener = listener;
        return () => {
          visualAnalysisCancelListener = null;
        };
      }),
    },
    transcripts: {
      requestJobs: vi.fn(async (_scope, assetIds: string[]) => {
        requestedTranscriptAssets.push(assetIds);
        for (const assetId of assetIds) {
          const record = transcriptSnapshot.assets[assetId as `asset_${string}`];
          if (record) record.state = "queued";
        }
        return transcriptSnapshot;
      }),
      get: vi.fn(async () => transcriptSnapshot),
      beginJob: vi.fn(async () => ({
        jobId: "00000000-0000-4000-8000-000000000099",
      })),
      transcribeChunk: vi.fn(async (_scope, input) => {
        transcribedChunks.push(input);
      }),
      finalizeJob: vi.fn(async (_scope, jobId) => {
        finalizedTranscriptJobs.push(jobId);
        if (transcriptSnapshot.assets.asset_fixture)
          transcriptSnapshot.assets.asset_fixture.state = "ready";
        return transcriptSnapshot;
      }),
      failJob: failTranscriptJob,
      onChanged: vi.fn((listener: (snapshot: TranscriptSnapshot) => void) => {
        transcriptListener = listener;
        return () => {
          transcriptListener = null;
        };
      }),
    },
    derived: {
      get: vi.fn(async () => current),
      requestJobs: vi.fn(async () => current),
      onChanged: vi.fn((listener: (snapshot: DerivedMediaSnapshot) => void) => {
        derivedMediaListener = listener;
        return () => {
          derivedMediaListener = null;
        };
      }),
      beginWrite: vi.fn(
        async (_scope, input: { assetId: string; kind: string; expectedBytes?: number }) => {
          begun.push(input);
          return { writerId: `${input.kind}-writer` };
        },
      ),
      writeChunk: vi.fn(async () => undefined),
      finalizeWrite: vi.fn(async (writerId: string, result: FinalizeDerivedWrite) => {
        finalized.push({ writerId, result });
        const kind = writerId.startsWith("thumbnail")
          ? "thumbnail"
          : writerId.startsWith("filmstrip")
            ? "filmstrip"
            : "waveform";
        current.assets.asset_fixture![kind] = { state: "ready", bytes: result.bytes };
      }),
      cancelWrite: vi.fn(async (writerId: string, failureCode?: string, detail?: string) => {
        canceled.push({
          writerId,
          ...(failureCode ? { failureCode } : {}),
          ...(detail ? { detail } : {}),
        });
        const kind = writerId.startsWith("thumbnail")
          ? "thumbnail"
          : writerId.startsWith("filmstrip")
            ? "filmstrip"
            : "waveform";
        current.assets.asset_fixture![kind] = failureCode
          ? { state: "failed", failureCode }
          : { state: "queued" };
      }),
      updateProgress: vi.fn(async () => undefined),
      reportActivity: vi.fn(async () => undefined),
      reportPerformance: vi.fn(async () => undefined),
    },
  } as unknown as DesktopApi;
  vi.stubGlobal("window", { cinesim: api });
  vi.stubGlobal("Worker", FakeWorker);
  return {
    api,
    begun,
    finalized,
    canceled,
    transcribedChunks,
    finalizedTranscriptJobs,
    requestedTranscriptAssets,
    failTranscriptJob,
    completeFrame,
    completeVisualAnalysis,
    completeExport,
    failExport,
    emitDerivedMedia: (next: DerivedMediaSnapshot) => derivedMediaListener?.(next),
    emitTranscripts: (next: TranscriptSnapshot) => transcriptListener?.(next),
    emitFrame: (request: import("../src/shared/contracts").FrameRenderRequest) =>
      frameListener?.(request),
    cancelFrame: (requestId: string) => frameCancelListener?.({ requestId }),
    emitVisualAnalysis: (request: import("../src/shared/contracts").VisualAnalysisRequest) =>
      visualAnalysisListener?.(request),
    cancelVisualAnalysis: (requestId: string) => visualAnalysisCancelListener?.({ requestId }),
    emitExport: (request: import("../src/shared/contracts").ExportRenderRequest) =>
      exportListener?.(request),
    cancelExport: (jobId: string) => exportCancelListener?.({ jobId }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instance = null;
  FakeWorker.instances.length = 0;
});

describe("MediaJobCoordinator", () => {
  it("renders exports only from the matching accepted generation and honors cancellation", async () => {
    const fixture = setup(snapshot("ready", "ready", "ready"));
    const currentProject = project();
    let resolveRender:
      | ((value: import("../src/shared/contracts").ExportRenderCompletion) => void)
      | null = null;
    const exportRenderer = vi.fn(
      ({
        request,
        signal,
      }: Parameters<
        import("../src/renderer/lib/export-job-coordinator").AcceptedExportRenderer
      >[0]) =>
        new Promise<import("../src/shared/contracts").ExportRenderCompletion>((resolve, reject) => {
          resolveRender = resolve;
          signal.addEventListener("abort", () =>
            reject(new DOMException("Export canceled", "AbortError")),
          );
          expect(request.job.acceptedGeneration).toBe("generation_fixture");
        }),
    );
    const coordinator = new MediaJobCoordinator(currentProject, projectScope, () => undefined, {
      acceptedGeneration: "generation_fixture",
      program: projectToIr(currentProject),
      exportRenderer,
    });
    await coordinator.start();
    const request = {
      projectScope,
      job: {
        id: "export_fixture",
        state: "rendering" as const,
        sequenceId: currentProject.activeSequenceId,
        presetId: "h264-aac-sdr-1080p" as const,
        startUs: timeUs(0),
        endUs: timeUs(1_000_000),
        width: 1280,
        height: 720,
        frameRate: 30,
        progress: 0,
        acceptedGeneration: "generation_fixture",
      },
    };

    fixture.emitExport(request);
    await vi.waitFor(() => expect(exportRenderer).toHaveBeenCalledOnce());
    fixture.cancelExport(request.job.id);
    await vi.waitFor(() =>
      expect(fixture.failExport).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: request.job.id, code: "canceled" }),
      ),
    );
    expect(fixture.completeExport).not.toHaveBeenCalled();

    fixture.emitExport({
      ...request,
      job: { ...request.job, id: "export_stale", acceptedGeneration: "generation_stale" },
    });
    await vi.waitFor(() =>
      expect(fixture.failExport).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "export_stale", code: "stale-export-request" }),
      ),
    );
    expect(exportRenderer).toHaveBeenCalledOnce();
    expect(resolveRender).toBeTypeOf("function");
    await coordinator.destroy();
  });

  it("runs visual analysis in an isolated worker only when foreground work is idle", async () => {
    const fixture = setup(snapshot("ready", "ready", "ready"));
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined, {
      acceptedGeneration: "generation_fixture",
    });
    await coordinator.start();
    coordinator.setForegroundPressure("playing");
    const request = {
      requestId: "00000000-0000-4000-8000-000000000055",
      projectScope,
      assetId: "asset_fixture",
      durationUs: timeUs(2_000_000),
      acceptedGeneration: "generation_fixture",
    };
    fixture.emitVisualAnalysis(request);
    expect(FakeWorker.instances).toHaveLength(1);

    coordinator.setForegroundPressure("idle");
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    expect(FakeWorker.instances[1]?.sent).toContainEqual({
      type: "visual-index",
      jobId: request.requestId,
      assetId: "asset_fixture",
      projectScope,
      durationUs: timeUs(2_000_000),
    });
    FakeWorker.instances[1]!.emit({
      type: "visual-index-complete",
      jobId: request.requestId,
      options: { analyzer: "fixture" },
      coverage: [{ sourceInUs: 0, sourceOutUs: timeUs(2_000_000) }],
      observations: [
        {
          id: "observation_fixture",
          sourceInUs: 0,
          sourceOutUs: timeUs(2_000_000),
          description: "Fixture evidence",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(fixture.completeVisualAnalysis).toHaveBeenCalledWith(
        projectScope,
        expect.objectContaining({ requestId: request.requestId }),
      ),
    );
    await coordinator.destroy();
  });

  it("prioritizes and publishes one bounded exact asset frame", async () => {
    const fixture = setup(snapshot("ready", "ready", "ready"));
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    await coordinator.start();
    const request = {
      requestId: "00000000-0000-4000-8000-000000000088",
      projectScope,
      target: { kind: "asset" as const, assetId: "asset_fixture" },
      quality: "medium" as const,
      requestedTimeUs: timeUs(510_000),
      normalizedTimeUs: timeUs(500_000),
      width: 1280,
      height: 720,
      acceptedGeneration: "generation_fixture",
    };

    fixture.emitFrame(request);
    await vi.waitFor(() =>
      expect(FakeWorker.instance?.sent).toContainEqual({
        type: "frame",
        jobId: request.requestId,
        assetId: "asset_fixture",
        projectScope,
        atUs: timeUs(500_000),
        width: 1280,
        height: 720,
      }),
    );
    const frame = new Uint8Array([137, 80, 78, 71]).buffer;
    FakeWorker.instance?.emit({
      type: "frame-complete",
      jobId: request.requestId,
      frame,
      renderedTimeUs: timeUs(480_000),
      width: 1280,
      height: 720,
    });

    await vi.waitFor(() =>
      expect(fixture.completeFrame).toHaveBeenCalledWith(projectScope, {
        requestId: request.requestId,
        renderedTimeUs: timeUs(480_000),
        width: 1280,
        height: 720,
        png: new Uint8Array([137, 80, 78, 71]),
      }),
    );
    await coordinator.destroy();
  });

  it("does not starve exact frames behind active background perception", async () => {
    const fixture = setup(snapshot());
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    await coordinator.start();
    await vi.waitFor(() =>
      expect(FakeWorker.instances[0]?.sent).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "generate" })]),
      ),
    );
    const request = {
      requestId: "00000000-0000-4000-8000-000000000066",
      projectScope,
      target: { kind: "asset" as const, assetId: "asset_fixture" },
      quality: "low" as const,
      requestedTimeUs: timeUs(0),
      normalizedTimeUs: timeUs(0),
      width: 640,
      height: 360,
      acceptedGeneration: "generation_fixture",
    };

    fixture.emitFrame(request);

    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    expect(FakeWorker.instances[1]?.sent).toContainEqual(
      expect.objectContaining({ type: "frame", jobId: request.requestId }),
    );
    expect(FakeWorker.instances[0]?.sent).not.toContainEqual(
      expect.objectContaining({ type: "cancel" }),
    );
    fixture.cancelFrame(request.requestId);
    await coordinator.destroy();
  });

  it("renders accepted timeline frames through the injected WebGPU sampling path", async () => {
    const currentProject = project();
    const fixture = setup(snapshot("ready", "ready", "ready"));
    const timelineRenderer = vi.fn(async ({ request }) => ({
      frame: new Uint8Array([9, 8, 7]).buffer,
      renderedTimeUs: request.normalizedTimeUs,
      width: request.width,
      height: request.height,
    }));
    const coordinator = new MediaJobCoordinator(currentProject, projectScope, () => undefined, {
      acceptedGeneration: "generation_fixture",
      program: projectToIr(currentProject),
      timelineRenderer,
    });
    await coordinator.start();
    const request = {
      requestId: "00000000-0000-4000-8000-000000000077",
      projectScope,
      target: {
        kind: "timeline" as const,
        sequenceId: currentProject.activeSequenceId,
      },
      quality: "low" as const,
      requestedTimeUs: timeUs(42_000),
      normalizedTimeUs: timeUs(33_333),
      width: 640,
      height: 360,
      acceptedGeneration: "generation_fixture",
    };

    fixture.emitFrame(request);
    await vi.waitFor(() => expect(timelineRenderer).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(fixture.completeFrame).toHaveBeenCalledWith(projectScope, {
        requestId: request.requestId,
        renderedTimeUs: timeUs(33_333),
        width: 640,
        height: 360,
        png: new Uint8Array([9, 8, 7]),
      }),
    );
    expect(FakeWorker.instance?.sent).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "frame" })]),
    );
    await coordinator.destroy();
  });

  it("tracks transcript progress without mutating a frozen contextBridge snapshot", async () => {
    const record = Object.freeze({ assetId: "asset_fixture", state: "queued" as const });
    const transcripts = Object.freeze({
      projectDirectory: "/tmp/project",
      projectScope: Object.freeze({ ...projectScope }),
      assets: Object.freeze({ asset_fixture: record }),
    }) as TranscriptSnapshot;
    setup(snapshot("ready", "ready", "ready"), transcripts);
    const published: TranscriptSnapshot[] = [];
    const coordinator = new MediaJobCoordinator(project(true), projectScope, () => undefined, {
      onTranscriptSnapshot: (next) => published.push(next),
    });
    await coordinator.start();
    await vi.waitFor(() =>
      expect(FakeWorker.instance?.sent).toContainEqual(
        expect.objectContaining({ type: "transcript" }),
      ),
    );

    FakeWorker.instance!.emit({
      type: "transcript-progress",
      jobId: "00000000-0000-4000-8000-000000000099",
      progress: 0.5,
    });

    await vi.waitFor(() => expect(published.at(-1)?.assets.asset_fixture?.progress).toBe(0.5));
    expect("progress" in record).toBe(false);
    await coordinator.destroy();
  });

  it("bounds progress publications and isolates subscriber failures from transcript jobs", async () => {
    const transcripts: TranscriptSnapshot = {
      projectDirectory: "/tmp/project",
      projectScope,
      assets: {
        asset_fixture: { assetId: "asset_fixture", state: "queued" },
      },
    };
    const { failTranscriptJob } = setup(snapshot("ready", "ready", "ready"), transcripts);
    const publishedProgress: number[] = [];
    vi.stubGlobal("reportError", vi.fn());
    const coordinator = new MediaJobCoordinator(project(true), projectScope, () => undefined, {
      onTranscriptSnapshot: (next) => {
        const progress = next.assets.asset_fixture?.progress;
        if (progress !== undefined) publishedProgress.push(progress);
        if (publishedProgress.length === 2) throw new Error("presentation update failed");
      },
    });
    await coordinator.start();
    await vi.waitFor(() =>
      expect(FakeWorker.instance?.sent).toContainEqual(
        expect.objectContaining({ type: "transcript" }),
      ),
    );

    for (let percent = 1; percent <= 99; percent += 1) {
      FakeWorker.instance!.emit({
        type: "transcript-progress",
        jobId: "00000000-0000-4000-8000-000000000099",
        progress: percent / 100,
      });
    }

    await vi.waitFor(() => expect(publishedProgress.at(-1)).toBeGreaterThanOrEqual(0.95));
    expect(publishedProgress.length).toBeLessThanOrEqual(21);
    expect(globalThis.reportError).toHaveBeenCalledWith(expect.any(Error));
    expect(failTranscriptJob).not.toHaveBeenCalled();
    await coordinator.destroy();
  });

  it("queues missing speech media when account preferences enable automatic transcription", async () => {
    const withAudio = project();
    withAudio.assets[0]!.hasAudio = true;
    const transcripts: TranscriptSnapshot = {
      projectDirectory: "/tmp/project",
      projectScope,
      assets: {
        asset_fixture: { assetId: "asset_fixture", state: "missing" },
      },
    };
    const { requestedTranscriptAssets } = setup(snapshot("ready", "ready", "ready"), transcripts);
    const coordinator = new MediaJobCoordinator(withAudio, projectScope, () => undefined, {
      transcriptionSettings: { generation: "automatic", model: "deepgram/nova-3" },
    });

    await coordinator.start();

    expect(requestedTranscriptAssets).toEqual([["asset_fixture"]]);
    await coordinator.destroy();
  });

  it("extracts and uploads transcript chunks with worker backpressure", async () => {
    const transcripts: TranscriptSnapshot = {
      projectDirectory: "/tmp/project",
      projectScope,
      assets: {
        asset_fixture: { assetId: "asset_fixture", state: "queued" },
      },
    };
    const { transcribedChunks, finalizedTranscriptJobs } = setup(
      snapshot("ready", "ready", "ready"),
      transcripts,
    );
    const coordinator = new MediaJobCoordinator(project(true), projectScope, () => undefined);
    await coordinator.start();
    await vi.waitFor(() =>
      expect(FakeWorker.instance?.sent).toContainEqual(
        expect.objectContaining({
          type: "transcript",
          jobId: "00000000-0000-4000-8000-000000000099",
          chunkDurationUs: 300_000_000,
        }),
      ),
    );

    FakeWorker.instance!.emit({
      type: "transcript-chunk",
      jobId: "00000000-0000-4000-8000-000000000099",
      chunkIndex: 0,
      sourceStartUs: timeUs(0),
      sourceEndUs: timeUs(2_000_000),
      data: new Uint8Array([1, 2, 3]).buffer,
    });
    await vi.waitFor(() => expect(transcribedChunks).toHaveLength(1));
    expect(FakeWorker.instance?.sent).toContainEqual({
      type: "transcript-chunk-ack",
      jobId: "00000000-0000-4000-8000-000000000099",
      chunkIndex: 0,
    });

    FakeWorker.instance!.emit({
      type: "transcript-complete",
      jobId: "00000000-0000-4000-8000-000000000099",
    });
    await vi.waitFor(() => expect(finalizedTranscriptJobs).toHaveLength(1));
    await coordinator.destroy();
  });

  it("ignores snapshots emitted for another project with the same asset IDs", async () => {
    const { emitDerivedMedia } = setup(snapshot("ready", "ready"));
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    await coordinator.start();
    expect(FakeWorker.instance?.sent).toHaveLength(0);

    emitDerivedMedia({
      ...snapshot(),
      projectScope: { ...projectScope, cacheKey: "bbbbbbbbbbbbbbbbbbbbbbbb" },
    });
    await Promise.resolve();
    expect(FakeWorker.instance?.sent).toHaveLength(0);

    emitDerivedMedia(snapshot());
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));
    await coordinator.destroy();
  });

  it("publishes the thumbnail before filmstrip generation completes", async () => {
    const { finalized } = setup(snapshot());
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    await coordinator.start();
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));
    const request = FakeWorker.instance!.sent[0]!;
    expect(request).toMatchObject({ type: "generate", kinds: ["thumbnail", "filmstrip"] });
    const jobId = request.jobId;

    FakeWorker.instance!.emit({
      type: "thumbnail-complete",
      jobId,
      thumbnail: new Uint8Array([1, 2, 3]).buffer,
      sourceTimeUs: timeUs(500_000),
    });

    await vi.waitFor(() => expect(finalized).toHaveLength(1));
    expect(finalized[0]).toEqual({
      writerId: "thumbnail-writer",
      result: { bytes: 3, sourceTimeUs: timeUs(500_000) },
    });
    expect(finalized.some(({ writerId }) => writerId === "filmstrip-writer")).toBe(false);
    await coordinator.destroy();
  });

  it("keeps a published thumbnail when later filmstrip generation fails", async () => {
    const { finalized, canceled } = setup(snapshot());
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    await coordinator.start();
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));
    const request = FakeWorker.instance!.sent[0]!;
    const jobId = request.jobId;

    FakeWorker.instance!.emit({
      type: "thumbnail-complete",
      jobId,
      thumbnail: new Uint8Array([1]).buffer,
      sourceTimeUs: timeUs(250_000),
    });
    await vi.waitFor(() => expect(finalized).toHaveLength(1));
    FakeWorker.instance!.emit({
      type: "failed",
      jobId,
      failureCode: "generation-failed",
      detail: "filmstrip decoder failed",
    });

    await vi.waitFor(() => expect(canceled).toHaveLength(1));
    expect(canceled).toEqual([
      {
        writerId: "filmstrip-writer",
        failureCode: "generation-failed",
        detail: "filmstrip decoder failed",
      },
    ]);
    await coordinator.destroy();
  });

  it("only requests missing artifacts and reuses the thumbnail sample time", async () => {
    setup(snapshot("ready", "queued"));
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    await coordinator.start();
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));

    expect(FakeWorker.instance!.sent[0]).toMatchObject({
      type: "generate",
      kinds: ["filmstrip"],
      thumbnailSourceTimeUs: 500_000,
    });
    await coordinator.destroy();
  });

  it("publishes a bounded waveform for video with embedded audio", async () => {
    const withAudio = project();
    withAudio.assets[0]!.hasAudio = true;
    const peakCount = waveformPeakCount(withAudio.assets[0]!.durationUs);
    const expectedBytes = waveformByteLength(peakCount);
    const { begun, finalized } = setup(snapshot("ready", "ready", "queued"));
    const coordinator = new MediaJobCoordinator(withAudio, projectScope, () => undefined);
    await coordinator.start();
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));
    const request = FakeWorker.instance!.sent[0]!;
    expect(request).toMatchObject({ type: "generate", kinds: ["waveform"] });
    expect(begun).toContainEqual({
      assetId: "asset_fixture",
      kind: "waveform",
      expectedBytes,
    });

    FakeWorker.instance!.emit({
      type: "waveform-complete",
      jobId: request.jobId,
      waveform: new ArrayBuffer(expectedBytes),
      peakCount,
      waveformFormatVersion: WAVEFORM_FORMAT_VERSION,
    });
    await vi.waitFor(() => expect(finalized).toHaveLength(1));
    expect(finalized[0]).toEqual({
      writerId: "waveform-writer",
      result: { bytes: expectedBytes, peakCount, waveformFormatVersion: WAVEFORM_FORMAT_VERSION },
    });
    await coordinator.destroy();
  });

  it("defers derived decoding while foreground playback has priority", async () => {
    setup(snapshot());
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    coordinator.setForegroundPressure("playing");
    await coordinator.start();
    expect(FakeWorker.instance?.sent).toHaveLength(0);

    coordinator.setForegroundPressure("idle");
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));
    await coordinator.destroy();
  });

  it("replaces a crashed worker after recording the active job failure", async () => {
    const { canceled } = setup(snapshot());
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    await coordinator.start();
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));
    const crashed = FakeWorker.instance!;

    crashed.onerror?.({ message: "decoder process exited" } as ErrorEvent);

    await vi.waitFor(() => expect(canceled).toHaveLength(2));
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    expect(FakeWorker.instance).not.toBe(crashed);
    expect(canceled).toEqual([
      {
        writerId: "thumbnail-writer",
        failureCode: "worker-crashed",
        detail: "decoder process exited",
      },
      {
        writerId: "filmstrip-writer",
        failureCode: "worker-crashed",
        detail: "decoder process exited",
      },
    ]);
    await coordinator.destroy();
  });

  it("fails and replaces a worker that stops producing activity", async () => {
    vi.useFakeTimers();
    const { canceled } = setup(snapshot());
    const coordinator = new MediaJobCoordinator(project(), projectScope, () => undefined);
    await coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWorker.instance?.sent).toHaveLength(1);
    const stalled = FakeWorker.instance!;

    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(canceled).toEqual([
      {
        writerId: "thumbnail-writer",
        failureCode: "worker-timeout",
        detail: "Derived media worker produced no activity for 120000ms",
      },
      {
        writerId: "filmstrip-writer",
        failureCode: "worker-timeout",
        detail: "Derived media worker produced no activity for 120000ms",
      },
    ]);
    expect(FakeWorker.instance).not.toBe(stalled);
    await coordinator.destroy();
  });
});

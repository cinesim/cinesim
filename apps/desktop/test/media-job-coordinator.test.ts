import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import type { DerivedMediaSnapshot, DesktopApi, FinalizeDerivedWrite } from "../src/shared/api";
import type {
  DerivedWorkerRequest,
  DerivedWorkerResponse,
} from "../src/renderer/lib/derived-worker-api";
import { MediaJobCoordinator } from "../src/renderer/lib/media-job-coordinator";

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

function project(): Project {
  return applyCommand(createProject({ name: "Coordinator" }), {
    type: "asset.import",
    asset: {
      id: "asset_fixture",
      kind: "video",
      name: "fixture.mp4",
      source: { kind: "local", path: "/tmp/fixture.mp4" },
      durationUs: 2_000_000,
      width: 1280,
      height: 720,
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
          thumbnail === "ready" ? { ...state(thumbnail), sourceTimeUs: 500_000 } : state(thumbnail),
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
          decision: "observing",
          reasons: [],
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

function setup(initial: DerivedMediaSnapshot) {
  const current = structuredClone(initial);
  let derivedMediaListener: ((snapshot: DerivedMediaSnapshot) => void) | null = null;
  const finalized: { writerId: string; result: FinalizeDerivedWrite }[] = [];
  const begun: { assetId: string; kind: string; expectedBytes?: number }[] = [];
  const canceled: { writerId: string; failureCode?: string; detail?: string }[] = [];
  const api = {
    getDerivedMediaSnapshot: vi.fn(async () => current),
    requestDerivedJobs: vi.fn(async () => current),
    onDerivedMediaChanged: vi.fn((listener: (snapshot: DerivedMediaSnapshot) => void) => {
      derivedMediaListener = listener;
      return () => {
        derivedMediaListener = null;
      };
    }),
    beginDerivedWrite: vi.fn(
      async (_scope, input: { assetId: string; kind: string; expectedBytes?: number }) => {
        begun.push(input);
        return { writerId: `${input.kind}-writer` };
      },
    ),
    writeDerivedChunk: vi.fn(async () => undefined),
    finalizeDerivedWrite: vi.fn(async (writerId: string, result: FinalizeDerivedWrite) => {
      finalized.push({ writerId, result });
      const kind = writerId.startsWith("thumbnail")
        ? "thumbnail"
        : writerId.startsWith("filmstrip")
          ? "filmstrip"
          : "waveform";
      current.assets.asset_fixture![kind] = { state: "ready", bytes: result.bytes };
    }),
    cancelDerivedWrite: vi.fn(async (writerId: string, failureCode?: string, detail?: string) => {
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
    updateDerivedProgress: vi.fn(async () => undefined),
    reportDerivedActivity: vi.fn(async () => undefined),
    reportDerivedPerformance: vi.fn(async () => undefined),
  } as unknown as DesktopApi;
  vi.stubGlobal("window", { cinesim: api });
  vi.stubGlobal("Worker", FakeWorker);
  return {
    api,
    begun,
    finalized,
    canceled,
    emitDerivedMedia: (next: DerivedMediaSnapshot) => derivedMediaListener?.(next),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instance = null;
  FakeWorker.instances.length = 0;
});

describe("MediaJobCoordinator", () => {
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
      sourceTimeUs: 500_000,
    });

    await vi.waitFor(() => expect(finalized).toHaveLength(1));
    expect(finalized[0]).toEqual({
      writerId: "thumbnail-writer",
      result: { bytes: 3, sourceTimeUs: 500_000 },
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
      sourceTimeUs: 250_000,
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
    const { begun, finalized } = setup(snapshot("ready", "ready", "queued"));
    const coordinator = new MediaJobCoordinator(withAudio, projectScope, () => undefined);
    await coordinator.start();
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));
    const request = FakeWorker.instance!.sent[0]!;
    expect(request).toMatchObject({ type: "generate", kinds: ["waveform"] });
    expect(begun).toContainEqual({
      assetId: "asset_fixture",
      kind: "waveform",
      expectedBytes: 176,
    });

    FakeWorker.instance!.emit({
      type: "waveform-complete",
      jobId: request.jobId,
      waveform: new ArrayBuffer(176),
      peakCount: 40,
      waveformFormatVersion: 1,
    });
    await vi.waitFor(() => expect(finalized).toHaveLength(1));
    expect(finalized[0]).toEqual({
      writerId: "waveform-writer",
      result: { bytes: 176, peakCount: 40, waveformFormatVersion: 1 },
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

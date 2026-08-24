import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import type { DerivedMediaSnapshot, DesktopApi, FinalizeDerivedWrite } from "../src/shared/api";
import type {
  DerivedWorkerRequest,
  DerivedWorkerResponse,
} from "../src/renderer/media/derived-worker-api";
import { MediaJobCoordinator } from "../src/renderer/media/media-job-coordinator";

class FakeWorker {
  static instance: FakeWorker | null = null;
  onmessage: ((event: MessageEvent<DerivedWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: DerivedWorkerRequest[] = [];

  constructor() {
    FakeWorker.instance = this;
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
): DerivedMediaSnapshot {
  const state = (value: "queued" | "ready") =>
    value === "ready" ? ({ state: value, bytes: 100 } as const) : ({ state: value } as const);
  return {
    version: 1,
    generatorVersion: "1",
    assets: {
      asset_fixture: {
        assetId: "asset_fixture",
        fingerprintStatus: "current",
        thumbnail:
          thumbnail === "ready" ? { ...state(thumbnail), sourceTimeUs: 500_000 } : state(thumbnail),
        filmstrip: state(filmstrip),
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
      proxyBytes: 0,
      evictionCount: 0,
    },
    jobs: { queued: 2, running: 0, completed: 0, failed: 0 },
    decisionLog: [],
  };
}

function setup(initial: DerivedMediaSnapshot) {
  const finalized: { writerId: string; result: FinalizeDerivedWrite }[] = [];
  const canceled: { writerId: string; failureCode?: string; detail?: string }[] = [];
  const api = {
    getDerivedMediaSnapshot: vi.fn(async () => initial),
    requestDerivedJobs: vi.fn(async () => initial),
    onDerivedMediaChanged: vi.fn(() => () => undefined),
    beginDerivedWrite: vi.fn(async ({ kind }: { kind: string }) => ({
      writerId: `${kind}-writer`,
    })),
    writeDerivedChunk: vi.fn(async () => undefined),
    finalizeDerivedWrite: vi.fn(async (writerId: string, result: FinalizeDerivedWrite) => {
      finalized.push({ writerId, result });
    }),
    cancelDerivedWrite: vi.fn(async (writerId: string, failureCode?: string, detail?: string) => {
      canceled.push({
        writerId,
        ...(failureCode ? { failureCode } : {}),
        ...(detail ? { detail } : {}),
      });
    }),
    updateDerivedProgress: vi.fn(async () => undefined),
    reportDerivedPerformance: vi.fn(async () => undefined),
  } as unknown as DesktopApi;
  vi.stubGlobal("window", { cinesim: api });
  vi.stubGlobal("Worker", FakeWorker);
  return { api, finalized, canceled };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instance = null;
});

describe("MediaJobCoordinator", () => {
  it("publishes the thumbnail before filmstrip generation completes", async () => {
    const { finalized } = setup(snapshot());
    const coordinator = new MediaJobCoordinator(project(), () => undefined);
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
    const coordinator = new MediaJobCoordinator(project(), () => undefined);
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
    const coordinator = new MediaJobCoordinator(project(), () => undefined);
    await coordinator.start();
    await vi.waitFor(() => expect(FakeWorker.instance?.sent).toHaveLength(1));

    expect(FakeWorker.instance!.sent[0]).toMatchObject({
      type: "generate",
      kinds: ["filmstrip"],
      thumbnailSourceTimeUs: 500_000,
    });
    await coordinator.destroy();
  });
});

import type { Asset, Project } from "@cinesim/core";
import type {
  DerivedArtifactKind,
  DerivedMediaSnapshot,
  DerivedProjectScope,
  FinalizeDerivedWrite,
} from "../../shared/api";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "./derived-worker-api";

interface ActiveJob {
  jobId: string;
  assetId: string;
  kind: "perception" | "proxy";
  startedAtMs: number;
  writers: Partial<Record<DerivedArtifactKind, string>>;
}

const WORKER_INACTIVITY_TIMEOUT_MS = 120_000;

export class MediaJobCoordinator {
  #project: Project;
  readonly #projectScope: DerivedProjectScope;
  #snapshot: DerivedMediaSnapshot | null = null;
  #worker: Worker | null = null;
  #active: ActiveJob | null = null;
  #unsubscribe: (() => void) | null = null;
  #destroyed = false;
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #workerInactivityTimer: ReturnType<typeof setTimeout> | null = null;
  #messageQueue: Promise<void> = Promise.resolve();
  #foregroundPressure: "idle" | "hover-skimming" | "seeking" | "playing" = "idle";
  readonly #onSnapshot: (snapshot: DerivedMediaSnapshot) => void;

  constructor(
    project: Project,
    projectScope: DerivedProjectScope,
    onSnapshot: (snapshot: DerivedMediaSnapshot) => void,
  ) {
    this.#project = project;
    this.#projectScope = projectScope;
    this.#onSnapshot = onSnapshot;
  }

  async start(): Promise<void> {
    if (this.#destroyed || this.#worker) return;
    this.#createWorker();
    this.#unsubscribe = window.cinesim.onDerivedMediaChanged((snapshot) => {
      this.#acceptSnapshot(snapshot);
    });
    this.#acceptSnapshot(await window.cinesim.getDerivedMediaSnapshot(this.#projectScope));
    await this.updateProject(this.#project);
  }

  #createWorker(): void {
    const worker = new Worker(new URL("../workers/derived-media.worker.ts", import.meta.url), {
      type: "module",
      name: "cinesim-derived-media",
    });
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<DerivedWorkerResponse>) => {
      this.#messageQueue = this.#messageQueue
        .then(() => this.#handleWorkerMessage(event.data))
        .catch((error: unknown) =>
          this.#failActive(
            "coordinator-message-failed",
            error instanceof Error ? error.message : "Worker message handling failed",
          ),
        );
    };
    worker.onerror = (event) => {
      if (this.#worker === worker && this.#active)
        void this.#recoverWorker("worker-crashed", event.message || "Derived media worker crashed");
    };
  }

  async updateProject(project: Project): Promise<void> {
    this.#project = project;
    if (this.#destroyed) return;
    const videoIds = project.assets
      .filter((asset) => asset.kind === "video")
      .map((asset) => asset.id);
    this.#acceptSnapshot(await window.cinesim.requestDerivedJobs(this.#projectScope, videoIds));
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#resumeTimer) clearTimeout(this.#resumeTimer);
    this.#clearWorkerInactivityTimer();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#active) {
      this.#worker?.postMessage({
        type: "cancel",
        jobId: this.#active.jobId,
      } satisfies DerivedWorkerRequest);
      await Promise.all(
        Object.values(this.#active.writers).map((writerId) =>
          window.cinesim.cancelDerivedWrite(writerId).catch(() => undefined),
        ),
      );
    }
    this.#active = null;
    this.#worker?.terminate();
    this.#worker = null;
  }

  setForegroundPressure(pressure: "idle" | "hover-skimming" | "seeking" | "playing"): void {
    this.#foregroundPressure = pressure;
    const active = this.#active;
    if (!active || active.kind !== "proxy" || !this.#worker) return;
    if (this.#resumeTimer) {
      clearTimeout(this.#resumeTimer);
      this.#resumeTimer = null;
    }
    if (pressure !== "idle") {
      this.#clearWorkerInactivityTimer();
      this.#worker.postMessage({
        type: "proxy-pause",
        jobId: active.jobId,
      } satisfies DerivedWorkerRequest);
      return;
    }
    this.#resumeTimer = setTimeout(() => {
      if (this.#active?.jobId === active.jobId) {
        this.#worker?.postMessage({
          type: "proxy-resume",
          jobId: active.jobId,
        } satisfies DerivedWorkerRequest);
        this.#armWorkerInactivityTimer(active.jobId);
      }
      this.#resumeTimer = null;
    }, 750);
  }

  #acceptSnapshot(snapshot: DerivedMediaSnapshot): void {
    if (
      this.#destroyed ||
      snapshot.projectScope.cacheKey !== this.#projectScope.cacheKey ||
      snapshot.projectScope.epoch !== this.#projectScope.epoch
    )
      return;
    this.#snapshot = snapshot;
    this.#onSnapshot(snapshot);
    void this.#schedule();
  }

  async #schedule(): Promise<void> {
    if (this.#destroyed || this.#active || !this.#snapshot || !this.#worker) return;
    const asset = this.#project.assets.find((candidate) => {
      if (candidate.kind !== "video") return false;
      const derived = this.#snapshot!.assets[candidate.id];
      return derived?.thumbnail.state === "queued" || derived?.filmstrip.state === "queued";
    });
    if (!asset) {
      const proxyAsset = this.#project.assets.find(
        (candidate) =>
          candidate.kind === "video" &&
          this.#snapshot!.assets[candidate.id]?.proxy.state === "queued",
      );
      if (proxyAsset) await this.#startProxy(proxyAsset);
      return;
    }
    const record = this.#snapshot.assets[asset.id]!;
    const kinds = (["thumbnail", "filmstrip"] as const).filter(
      (kind) => record[kind].state === "queued",
    );
    const jobId = crypto.randomUUID();
    const active: ActiveJob = {
      jobId,
      assetId: asset.id,
      kind: "perception",
      startedAtMs: performance.now(),
      writers: {},
    };
    this.#active = active;
    try {
      for (const kind of kinds) {
        const writer = await window.cinesim.beginDerivedWrite(this.#projectScope, {
          assetId: asset.id,
          kind,
        });
        active.writers[kind] = writer.writerId;
      }
      await window.cinesim.reportDerivedActivity(this.#projectScope, {
        jobId,
        assetId: asset.id,
        jobKind: "perception",
        stage: "scheduled",
        elapsedMs: 0,
      });
      this.#worker.postMessage({
        type: "generate",
        jobId,
        assetId: asset.id,
        projectScope: this.#projectScope,
        durationUs: asset.durationUs,
        kinds,
        ...(record.thumbnail.sourceTimeUs !== undefined
          ? { thumbnailSourceTimeUs: record.thumbnail.sourceTimeUs }
          : {}),
      } satisfies DerivedWorkerRequest);
      this.#armWorkerInactivityTimer(jobId);
    } catch (error) {
      await this.#failActive(
        "job-start-failed",
        error instanceof Error ? error.message : "Derived job could not start",
      );
    }
  }

  async #startProxy(asset: Asset): Promise<void> {
    if (!this.#worker || this.#active) return;
    const jobId = crypto.randomUUID();
    const active: ActiveJob = {
      jobId,
      assetId: asset.id,
      kind: "proxy",
      startedAtMs: performance.now(),
      writers: {},
    };
    this.#active = active;
    try {
      const writer = await window.cinesim.beginDerivedWrite(this.#projectScope, {
        assetId: asset.id,
        kind: "proxy",
        profileId: "edit-1280",
      });
      active.writers.proxy = writer.writerId;
      await window.cinesim.reportDerivedActivity(this.#projectScope, {
        jobId,
        assetId: asset.id,
        jobKind: "proxy",
        stage: "scheduled",
        elapsedMs: 0,
      });
      this.#worker.postMessage({
        type: "proxy",
        jobId,
        assetId: asset.id,
        projectScope: this.#projectScope,
        width: asset.width ?? 1280,
        height: asset.height ?? 720,
        ...(asset.frameRate ? { frameRate: asset.frameRate } : {}),
      } satisfies DerivedWorkerRequest);
      this.#armWorkerInactivityTimer(jobId);
      this.setForegroundPressure(this.#foregroundPressure);
    } catch {
      await this.#failActive("proxy-start-failed");
    }
  }

  async #handleWorkerMessage(message: DerivedWorkerResponse): Promise<void> {
    const active = this.#active;
    if (!active || message.jobId !== active.jobId || this.#destroyed) return;
    if (active.kind !== "proxy" || this.#foregroundPressure === "idle")
      this.#armWorkerInactivityTimer(active.jobId);
    if (message.type === "activity") {
      await window.cinesim.reportDerivedActivity(this.#projectScope, {
        jobId: active.jobId,
        assetId: active.assetId,
        jobKind: active.kind,
        stage: message.stage,
        elapsedMs: message.elapsedMs,
        ...(message.completedSamples !== undefined
          ? { completedSamples: message.completedSamples }
          : {}),
        ...(message.totalSamples !== undefined ? { totalSamples: message.totalSamples } : {}),
      });
      return;
    }
    if (message.type === "progress") {
      const writerId = active.writers[message.stage];
      if (writerId) await window.cinesim.updateDerivedProgress(writerId, message.progress);
      return;
    }
    if (message.type === "proxy-progress") {
      const writerId = active.writers.proxy;
      if (writerId) await window.cinesim.updateDerivedProgress(writerId, message.progress);
      return;
    }
    if (message.type === "proxy-chunk") {
      const writerId = active.writers.proxy;
      if (!writerId) return;
      try {
        await window.cinesim.writeDerivedChunk(
          writerId,
          message.offset,
          new Uint8Array(message.data),
        );
        this.#worker?.postMessage({
          type: "proxy-chunk-ack",
          jobId: active.jobId,
          chunkId: message.chunkId,
        } satisfies DerivedWorkerRequest);
      } catch (error) {
        this.#worker?.postMessage({
          type: "proxy-chunk-ack",
          jobId: active.jobId,
          chunkId: message.chunkId,
          error: error instanceof Error ? error.message : "Proxy write failed",
        } satisfies DerivedWorkerRequest);
      }
      return;
    }
    if (message.type === "proxy-complete") {
      const writerId = active.writers.proxy;
      if (!writerId) return;
      try {
        await window.cinesim.finalizeDerivedWrite(writerId, { bytes: message.bytes });
        delete active.writers.proxy;
        this.#clearWorkerInactivityTimer();
        this.#active = null;
        await this.#schedule();
      } catch {
        await this.#failActive("proxy-finalize-failed");
      }
      return;
    }
    if (message.type === "failed") {
      await this.#failActive(message.failureCode, message.detail);
      return;
    }
    if (message.type === "thumbnail-complete") {
      try {
        await this.#publish("thumbnail", message.thumbnail, active, {
          sourceTimeUs: message.sourceTimeUs,
        });
      } catch (error) {
        await this.#failActive(
          "thumbnail-write-failed",
          error instanceof Error ? error.message : "Thumbnail could not be published",
        );
      }
      return;
    }
    if (message.type === "filmstrip-complete") {
      try {
        await this.#publish("filmstrip", message.filmstrip, active, {
          tileTimesUs: message.tileTimesUs,
          columns: message.columns,
          rows: message.rows,
          tileWidth: message.tileWidth,
          tileHeight: message.tileHeight,
        });
      } catch (error) {
        await this.#failActive(
          "filmstrip-write-failed",
          error instanceof Error ? error.message : "Filmstrip could not be published",
        );
      }
      return;
    }
    try {
      await window.cinesim.reportDerivedPerformance(this.#projectScope, {
        assetId: active.assetId,
        sourceKind: "original",
        operation: "sampling",
        latencyMs: message.samplingLatencyMs,
      });
      this.#clearWorkerInactivityTimer();
      this.#active = null;
      await this.#schedule();
    } catch (error) {
      await this.#failActive(
        "artifact-write-failed",
        error instanceof Error ? error.message : "Derived artifact could not be published",
      );
    }
  }

  async #publish(
    kind: "thumbnail" | "filmstrip",
    buffer: ArrayBuffer,
    active: ActiveJob,
    metadata: Omit<FinalizeDerivedWrite, "bytes">,
  ): Promise<void> {
    const writerId = active.writers[kind];
    if (!writerId) return;
    const bytes = new Uint8Array(buffer);
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      await window.cinesim.writeDerivedChunk(
        writerId,
        offset,
        bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)),
      );
    }
    await window.cinesim.finalizeDerivedWrite(writerId, { ...metadata, bytes: bytes.byteLength });
    delete active.writers[kind];
  }

  async #failActive(failureCode: string, detail?: string): Promise<void> {
    const active = this.#active;
    this.#clearWorkerInactivityTimer();
    this.#active = null;
    if (!active) return;
    await window.cinesim
      .reportDerivedActivity(this.#projectScope, {
        jobId: active.jobId,
        assetId: active.assetId,
        jobKind: active.kind,
        stage: "failed",
        elapsedMs: performance.now() - active.startedAtMs,
        failureCode,
        ...(detail ? { detail } : {}),
      })
      .catch(() => undefined);
    await Promise.all(
      Object.values(active.writers).map((writerId) =>
        window.cinesim.cancelDerivedWrite(writerId, failureCode, detail).catch(() => undefined),
      ),
    );
    if (!this.#destroyed)
      await window.cinesim
        .getDerivedMediaSnapshot(this.#projectScope)
        .then((snapshot) => this.#acceptSnapshot(snapshot))
        .catch(() => undefined);
  }

  #armWorkerInactivityTimer(jobId: string): void {
    this.#clearWorkerInactivityTimer();
    this.#workerInactivityTimer = setTimeout(() => {
      if (this.#active?.jobId === jobId)
        void this.#recoverWorker(
          "worker-timeout",
          `Derived media worker produced no activity for ${WORKER_INACTIVITY_TIMEOUT_MS}ms`,
        );
    }, WORKER_INACTIVITY_TIMEOUT_MS);
  }

  #clearWorkerInactivityTimer(): void {
    if (!this.#workerInactivityTimer) return;
    clearTimeout(this.#workerInactivityTimer);
    this.#workerInactivityTimer = null;
  }

  async #recoverWorker(failureCode: string, detail: string): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    worker?.terminate();
    await this.#failActive(failureCode, detail);
    if (this.#destroyed || this.#worker) return;
    this.#messageQueue = Promise.resolve();
    this.#createWorker();
    await this.#schedule();
  }
}

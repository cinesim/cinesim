import type { Asset, Project, ProjectSettings } from "@cinesim/core";
import { DEFAULT_SETTINGS } from "@cinesim/core";
import type {
  DerivedArtifactKind,
  DerivedMediaSnapshot,
  DerivedProjectScope,
  FinalizeDerivedWrite,
  TranscriptionSettings,
} from "../../shared/api";
import { DEFAULT_TRANSCRIPTION_SETTINGS } from "../../shared/api";
import type { TranscriptSnapshot } from "../../shared/transcript";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "./derived-worker-api";
import { waveformByteLength, waveformPeakCount } from "../../shared/waveform-format";

interface ActiveJob {
  jobId: string;
  assetId: string;
  kind: "perception" | "proxy" | "transcript";
  startedAtMs: number;
  writers: Partial<Record<DerivedArtifactKind, string>>;
}

const WORKER_INACTIVITY_TIMEOUT_MS = 120_000;
const TRANSCRIPT_PROGRESS_STEPS = 20;

export class MediaJobCoordinator {
  #project: Project;
  #settings: ProjectSettings;
  #transcriptionSettings: TranscriptionSettings;
  readonly #projectScope: DerivedProjectScope;
  #snapshot: DerivedMediaSnapshot | null = null;
  #transcriptSnapshot: TranscriptSnapshot | null = null;
  #worker: Worker | null = null;
  #active: ActiveJob | null = null;
  #unsubscribe: (() => void) | null = null;
  #destroyed = false;
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #workerInactivityTimer: ReturnType<typeof setTimeout> | null = null;
  #messageQueue: Promise<void> = Promise.resolve();
  #foregroundPressure: "idle" | "hover-skimming" | "seeking" | "playing" | "dragging" = "idle";
  readonly #onSnapshot: (snapshot: DerivedMediaSnapshot) => void;
  readonly #onTranscriptSnapshot: (snapshot: TranscriptSnapshot) => void;

  constructor(
    project: Project,
    projectScope: DerivedProjectScope,
    onSnapshot: (snapshot: DerivedMediaSnapshot) => void,
    settings: ProjectSettings = DEFAULT_SETTINGS,
    onTranscriptSnapshot: (snapshot: TranscriptSnapshot) => void = () => undefined,
    transcriptionSettings: TranscriptionSettings = DEFAULT_TRANSCRIPTION_SETTINGS,
  ) {
    this.#project = project;
    this.#settings = settings;
    this.#projectScope = projectScope;
    this.#onSnapshot = onSnapshot;
    this.#onTranscriptSnapshot = onTranscriptSnapshot;
    this.#transcriptionSettings = transcriptionSettings;
  }

  async start(): Promise<void> {
    if (this.#destroyed || this.#worker) return;
    this.#createWorker();
    this.#unsubscribe = window.cinesim.onDerivedMediaChanged((snapshot) => {
      this.#acceptSnapshot(snapshot);
    });
    const unsubscribeTranscripts = window.cinesim.onTranscriptsChanged((snapshot) => {
      this.#acceptTranscriptSnapshot(snapshot);
    });
    const unsubscribeDerived = this.#unsubscribe;
    this.#unsubscribe = () => {
      unsubscribeDerived?.();
      unsubscribeTranscripts();
    };
    const [derived, transcripts] = await Promise.all([
      window.cinesim.getDerivedMediaSnapshot(this.#projectScope),
      window.cinesim.getTranscriptSnapshot(this.#projectScope),
    ]);
    this.#acceptSnapshot(derived);
    this.#acceptTranscriptSnapshot(transcripts);
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

  #notifyTranscriptSnapshot(snapshot: TranscriptSnapshot): void {
    try {
      this.#onTranscriptSnapshot(snapshot);
    } catch (error) {
      // A presentation subscriber must never turn a valid media job into a failed artifact.
      globalThis.reportError?.(error);
    }
  }

  async updateProject(project: Project, settings: ProjectSettings = this.#settings): Promise<void> {
    this.#project = project;
    this.#settings = settings;
    if (this.#destroyed) return;
    const mediaIds = project.assets
      .filter((asset) => asset.kind === "video" || asset.kind === "audio")
      .map((asset) => asset.id);
    this.#acceptSnapshot(await window.cinesim.requestDerivedJobs(this.#projectScope, mediaIds));
    this.#acceptTranscriptSnapshot(await window.cinesim.getTranscriptSnapshot(this.#projectScope));
    await this.#queueAutomaticTranscripts();
  }

  async updateTranscriptionSettings(settings: TranscriptionSettings): Promise<void> {
    this.#transcriptionSettings = settings;
    await this.#queueAutomaticTranscripts();
  }

  async #queueAutomaticTranscripts(): Promise<void> {
    if (
      this.#destroyed ||
      this.#transcriptionSettings.generation !== "automatic" ||
      !this.#transcriptSnapshot
    )
      return;
    const assetIds = this.#project.assets.flatMap((asset) => {
      if (asset.kind === "image" || (asset.kind === "video" && asset.hasAudio !== true)) return [];
      return this.#transcriptSnapshot?.assets[asset.id]?.state === "missing" ? [asset.id] : [];
    });
    if (!assetIds.length) return;
    try {
      this.#acceptTranscriptSnapshot(
        await window.cinesim.requestTranscriptJobs(this.#projectScope, assetIds),
      );
    } catch {
      // Account/service availability is reflected by account health; manual controls remain usable.
    }
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
      if (this.#active.kind === "transcript") {
        await window.cinesim
          .failTranscriptJob(this.#projectScope, this.#active.jobId, "canceled")
          .catch(() => undefined);
      }
    }
    this.#active = null;
    this.#worker?.terminate();
    this.#worker = null;
  }

  setForegroundPressure(
    pressure: "idle" | "hover-skimming" | "seeking" | "playing" | "dragging",
  ): void {
    this.#foregroundPressure = pressure;
    const active = this.#active;
    if (!active || !this.#worker) {
      if (pressure === "idle") void this.#schedule();
      return;
    }
    if (this.#resumeTimer) {
      clearTimeout(this.#resumeTimer);
      this.#resumeTimer = null;
    }
    if (pressure !== "idle") {
      this.#clearWorkerInactivityTimer();
      this.#worker.postMessage({
        type:
          active.kind === "proxy"
            ? "proxy-pause"
            : active.kind === "transcript"
              ? "transcript-pause"
              : "perception-pause",
        jobId: active.jobId,
      } satisfies DerivedWorkerRequest);
      return;
    }
    this.#resumeTimer = setTimeout(() => {
      if (this.#active?.jobId === active.jobId) {
        this.#worker?.postMessage({
          type:
            active.kind === "proxy"
              ? "proxy-resume"
              : active.kind === "transcript"
                ? "transcript-resume"
                : "perception-resume",
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

  #acceptTranscriptSnapshot(snapshot: TranscriptSnapshot): void {
    if (
      this.#destroyed ||
      snapshot.projectScope.cacheKey !== this.#projectScope.cacheKey ||
      snapshot.projectScope.epoch !== this.#projectScope.epoch
    ) {
      return;
    }
    // Values crossing contextBridge are copied and frozen. Keep an explicitly mutable local copy
    // for ephemeral progress updates rather than mutating the bridge-owned payload.
    this.#transcriptSnapshot = structuredClone(snapshot);
    this.#notifyTranscriptSnapshot(snapshot);
    const active = this.#active;
    if (
      active?.kind === "transcript" &&
      snapshot.assets[active.assetId as Asset["id"]]?.failureCode === "canceled"
    ) {
      this.#worker?.postMessage({
        type: "cancel",
        jobId: active.jobId,
      } satisfies DerivedWorkerRequest);
      this.#clearWorkerInactivityTimer();
      this.#active = null;
    }
    void this.#schedule();
  }

  async #schedule(): Promise<void> {
    if (
      this.#destroyed ||
      this.#active ||
      !this.#snapshot ||
      !this.#worker ||
      this.#foregroundPressure !== "idle"
    )
      return;
    const asset = this.#project.assets.find((candidate) => {
      const derived = this.#snapshot!.assets[candidate.id];
      if (!derived) return false;
      if (candidate.kind === "video")
        return (
          derived.thumbnail.state === "queued" ||
          derived.filmstrip.state === "queued" ||
          derived.waveform.state === "queued"
        );
      return candidate.kind === "audio" && derived.waveform.state === "queued";
    });
    if (!asset) {
      const proxyAsset = this.#project.assets.find(
        (candidate) =>
          (candidate.kind === "video" || candidate.kind === "audio") &&
          this.#snapshot!.assets[candidate.id]?.proxy.state === "queued",
      );
      if (proxyAsset) {
        await this.#startProxy(proxyAsset);
        return;
      }
      const transcriptAsset = this.#project.assets.find(
        (candidate) => this.#transcriptSnapshot?.assets[candidate.id]?.state === "queued",
      );
      if (transcriptAsset) await this.#startTranscript(transcriptAsset);
      return;
    }
    const record = this.#snapshot.assets[asset.id]!;
    const kinds = (["thumbnail", "filmstrip", "waveform"] as const).filter((kind) => {
      if (record[kind].state !== "queued") return false;
      if (kind === "waveform") return asset.kind === "audio" || asset.hasAudio === true;
      return asset.kind === "video";
    });
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
          ...(kind === "waveform"
            ? { expectedBytes: waveformByteLength(waveformPeakCount(asset.durationUs)) }
            : {}),
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
      if (this.#foregroundPressure !== "idle") this.setForegroundPressure(this.#foregroundPressure);
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
        ...(this.#snapshot?.assets[asset.id]?.proxy.profileId
          ? { profileId: this.#snapshot.assets[asset.id]!.proxy.profileId }
          : {}),
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
        assetKind: asset.kind as "video" | "audio",
        maxLongEdge: this.#settings.proxyMaxLongEdge,
        frameRateCap: this.#settings.proxyFrameRateCap,
        quality: this.#settings.proxyQuality,
      } satisfies DerivedWorkerRequest);
      this.#armWorkerInactivityTimer(jobId);
      this.setForegroundPressure(this.#foregroundPressure);
    } catch {
      await this.#failActive("proxy-start-failed");
    }
  }

  async #startTranscript(asset: Asset): Promise<void> {
    if (!this.#worker || this.#active) return;
    try {
      const { jobId } = await window.cinesim.beginTranscriptJob(this.#projectScope, asset.id);
      this.#active = {
        jobId,
        assetId: asset.id,
        kind: "transcript",
        startedAtMs: performance.now(),
        writers: {},
      };
      this.#worker.postMessage({
        type: "transcript",
        jobId,
        assetId: asset.id,
        projectScope: this.#projectScope,
        durationUs: asset.durationUs,
        chunkDurationUs: 300_000_000,
      } satisfies DerivedWorkerRequest);
      this.#armWorkerInactivityTimer(jobId);
      this.setForegroundPressure(this.#foregroundPressure);
    } catch (error) {
      await this.#failActive(
        "transcript-start-failed",
        error instanceof Error ? error.message : "Transcript job could not start",
      );
    }
  }

  async #handleWorkerMessage(message: DerivedWorkerResponse): Promise<void> {
    const active = this.#active;
    if (!active || message.jobId !== active.jobId || this.#destroyed) return;
    if (this.#foregroundPressure === "idle") this.#armWorkerInactivityTimer(active.jobId);
    if (message.type === "activity") {
      if (active.kind === "transcript") return;
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
    if (message.type === "transcript-progress") {
      const currentRecord = this.#transcriptSnapshot?.assets[active.assetId as Asset["id"]];
      const nextProgress = Math.max(
        currentRecord?.progress ?? 0,
        Math.min(1, Math.max(0, message.progress)),
      );
      if (!currentRecord || currentRecord.progress === nextProgress) return;
      const previousStep = Math.floor((currentRecord.progress ?? 0) * TRANSCRIPT_PROGRESS_STEPS);
      const nextStep = Math.floor(nextProgress * TRANSCRIPT_PROGRESS_STEPS);
      const snapshot = structuredClone(this.#transcriptSnapshot!);
      const record = snapshot.assets[active.assetId as Asset["id"]];
      if (record) {
        record.progress = nextProgress;
        this.#transcriptSnapshot = snapshot;
        if (currentRecord.progress === undefined || previousStep !== nextStep || nextProgress === 1)
          this.#notifyTranscriptSnapshot(snapshot);
      }
      return;
    }
    if (message.type === "transcript-chunk") {
      try {
        await window.cinesim.transcribeAudioChunk(this.#projectScope, {
          jobId: active.jobId,
          chunkIndex: message.chunkIndex,
          sourceStartUs: message.sourceStartUs,
          sourceEndUs: message.sourceEndUs,
          data: new Uint8Array(message.data),
        });
        this.#worker?.postMessage({
          type: "transcript-chunk-ack",
          jobId: active.jobId,
          chunkIndex: message.chunkIndex,
        } satisfies DerivedWorkerRequest);
      } catch (error) {
        this.#worker?.postMessage({
          type: "transcript-chunk-ack",
          jobId: active.jobId,
          chunkIndex: message.chunkIndex,
          error: error instanceof Error ? error.message : "Transcript request failed",
        } satisfies DerivedWorkerRequest);
      }
      return;
    }
    if (message.type === "transcript-complete") {
      try {
        const snapshot = await window.cinesim.finalizeTranscriptJob(
          this.#projectScope,
          active.jobId,
        );
        this.#clearWorkerInactivityTimer();
        this.#active = null;
        this.#acceptTranscriptSnapshot(snapshot);
        await this.#schedule();
      } catch (error) {
        await this.#failActive(
          "transcript-finalize-failed",
          error instanceof Error ? error.message : "Transcript could not be published",
        );
      }
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
    if (message.type === "waveform-complete") {
      try {
        await this.#publish("waveform", message.waveform, active, {
          peakCount: message.peakCount,
          waveformFormatVersion: message.waveformFormatVersion,
        });
      } catch (error) {
        await this.#failActive(
          "waveform-write-failed",
          error instanceof Error ? error.message : "Waveform could not be published",
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
    kind: "thumbnail" | "filmstrip" | "waveform",
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
    if (active.kind === "transcript") {
      await window.cinesim
        .failTranscriptJob(this.#projectScope, active.jobId, failureCode, detail)
        .then((snapshot) => this.#acceptTranscriptSnapshot(snapshot))
        .catch(() => undefined);
      if (!this.#destroyed) await this.#schedule();
      return;
    }
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

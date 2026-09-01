import type { Asset, Project, ProjectSettings } from "@cinesim/core";
import type { IrProgram } from "@cinesim/ir";
import { DEFAULT_SETTINGS, timeUs } from "@cinesim/core";
import type {
  DerivedArtifactKind,
  DerivedMediaSnapshot,
  DerivedProjectScope,
  FinalizeDerivedWrite,
  TranscriptionSettings,
} from "../../shared/contracts";
import { DEFAULT_TRANSCRIPTION_SETTINGS } from "../../shared/contracts";
import type { TranscriptSnapshot } from "../../shared/transcript";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "./derived-worker-api";
import { waveformByteLength, waveformPeakCount } from "../../shared/waveform-format";
import { FrameJobCoordinator, type TimelineRenderer } from "./frame-job-coordinator";
import { ExportJobCoordinator, type AcceptedExportRenderer } from "./export-job-coordinator";
import { VisualAnalysisJobCoordinator } from "./visual-analysis-job-coordinator";

interface ActiveJob {
  jobId: string;
  assetId: string;
  kind: "perception" | "proxy" | "transcript";
  startedAtMs: number;
  writers: Partial<Record<DerivedArtifactKind, string>>;
}

const WORKER_INACTIVITY_TIMEOUT_MS = 120_000;
const TRANSCRIPT_PROGRESS_STEPS = 20;

export interface MediaJobCoordinatorOptions {
  settings?: ProjectSettings;
  onTranscriptSnapshot?: (snapshot: TranscriptSnapshot) => void;
  transcriptionSettings?: TranscriptionSettings;
  acceptedGeneration?: string;
  program?: IrProgram | null;
  timelineRenderer?: TimelineRenderer;
  exportRenderer?: AcceptedExportRenderer;
}

type WorkerResponse<Type extends DerivedWorkerResponse["type"]> = Extract<
  DerivedWorkerResponse,
  { type: Type }
>;

function workerPressureControl(
  kind: ActiveJob["kind"],
  action: "pause" | "resume",
):
  | "perception-pause"
  | "perception-resume"
  | "proxy-pause"
  | "proxy-resume"
  | "transcript-pause"
  | "transcript-resume" {
  if (kind === "proxy") return `proxy-${action}`;
  if (kind === "transcript") return `transcript-${action}`;
  return `perception-${action}`;
}

function queuedPerceptionAsset(
  project: Project,
  snapshot: DerivedMediaSnapshot,
): Asset | undefined {
  return project.assets.find((asset) => {
    const derived = snapshot.assets[asset.id];
    if (!derived) return false;
    if (asset.kind === "video") {
      return (
        derived.thumbnail.state === "queued" ||
        derived.filmstrip.state === "queued" ||
        derived.waveform.state === "queued"
      );
    }
    return asset.kind === "audio" && derived.waveform.state === "queued";
  });
}

function queuedProxyAsset(project: Project, snapshot: DerivedMediaSnapshot): Asset | undefined {
  return project.assets.find(
    (asset) =>
      (asset.kind === "video" || asset.kind === "audio") &&
      snapshot.assets[asset.id]?.proxy.state === "queued",
  );
}

function queuedTranscriptAsset(
  project: Project,
  snapshot: TranscriptSnapshot | null,
): Asset | undefined {
  return project.assets.find((asset) => snapshot?.assets[asset.id]?.state === "queued");
}

function queuedPerceptionKinds(
  asset: Asset,
  record: NonNullable<DerivedMediaSnapshot["assets"][Asset["id"]]>,
): Array<"thumbnail" | "filmstrip" | "waveform"> {
  return (["thumbnail", "filmstrip", "waveform"] as const).filter((kind) => {
    if (record[kind].state !== "queued") return false;
    if (kind === "waveform") return asset.kind === "audio" || asset.hasAudio === true;
    return asset.kind === "video";
  });
}

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
  #acceptedGeneration: string;
  #program: IrProgram | null;
  readonly #frames: FrameJobCoordinator;
  readonly #exports: ExportJobCoordinator;
  readonly #visualAnalysis: VisualAnalysisJobCoordinator;
  #foregroundPressure: "idle" | "hover-skimming" | "seeking" | "playing" | "dragging" = "idle";
  readonly #onSnapshot: (snapshot: DerivedMediaSnapshot) => void;
  readonly #onTranscriptSnapshot: (snapshot: TranscriptSnapshot) => void;

  constructor(
    project: Project,
    projectScope: DerivedProjectScope,
    onSnapshot: (snapshot: DerivedMediaSnapshot) => void,
    options: MediaJobCoordinatorOptions = {},
  ) {
    this.#project = project;
    this.#settings = options.settings ?? DEFAULT_SETTINGS;
    this.#projectScope = projectScope;
    this.#onSnapshot = onSnapshot;
    this.#onTranscriptSnapshot = options.onTranscriptSnapshot ?? (() => undefined);
    this.#transcriptionSettings = options.transcriptionSettings ?? DEFAULT_TRANSCRIPTION_SETTINGS;
    this.#acceptedGeneration = options.acceptedGeneration ?? "";
    this.#program = options.program ?? null;
    this.#frames = new FrameJobCoordinator({
      project,
      projectScope,
      acceptedGeneration: this.#acceptedGeneration,
      program: this.#program,
      ...(options.timelineRenderer ? { timelineRenderer: options.timelineRenderer } : {}),
    });
    this.#visualAnalysis = new VisualAnalysisJobCoordinator(projectScope, this.#acceptedGeneration);
    this.#exports = new ExportJobCoordinator({
      project,
      scope: projectScope,
      acceptedGeneration: this.#acceptedGeneration,
      program: this.#program,
      ...(options.exportRenderer ? { renderer: options.exportRenderer } : {}),
    });
  }

  async start(): Promise<void> {
    if (this.#destroyed || this.#worker) return;
    this.#frames.start();
    this.#exports.start();
    this.#visualAnalysis.start();
    this.#createWorker();
    this.#unsubscribe = window.cinesim.derived.onChanged((snapshot) => {
      this.#acceptSnapshot(snapshot);
    });
    const unsubscribeTranscripts = window.cinesim.transcripts.onChanged((snapshot) => {
      this.#acceptTranscriptSnapshot(snapshot);
    });
    const unsubscribeDerived = this.#unsubscribe;
    this.#unsubscribe = () => {
      unsubscribeDerived?.();
      unsubscribeTranscripts();
    };
    const [derived, transcripts] = await Promise.all([
      window.cinesim.derived.get(this.#projectScope),
      window.cinesim.transcripts.get(this.#projectScope),
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

  async updateProject(
    project: Project,
    settings: ProjectSettings = this.#settings,
    acceptedGeneration = this.#acceptedGeneration,
    program: IrProgram | null = this.#program,
  ): Promise<void> {
    this.#project = project;
    this.#settings = settings;
    this.#acceptedGeneration = acceptedGeneration;
    this.#program = program;
    this.#frames.update(project, program, acceptedGeneration);
    this.#exports.update(project, program, acceptedGeneration);
    this.#visualAnalysis.update(acceptedGeneration);
    if (this.#destroyed) return;
    const mediaIds = project.assets
      .filter((asset) => asset.kind === "video" || asset.kind === "audio")
      .map((asset) => asset.id);
    this.#acceptSnapshot(await window.cinesim.derived.requestJobs(this.#projectScope, mediaIds));
    this.#acceptTranscriptSnapshot(await window.cinesim.transcripts.get(this.#projectScope));
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
        await window.cinesim.transcripts.requestJobs(this.#projectScope, assetIds),
      );
    } catch {
      // Account/service availability is reflected by account health; manual controls remain usable.
    }
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#frames.destroy();
    this.#exports.destroy();
    this.#visualAnalysis.destroy();
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
          window.cinesim.derived.cancelWrite(writerId).catch(() => undefined),
        ),
      );
      if (this.#active.kind === "transcript") {
        await window.cinesim.transcripts
          .failJob(this.#projectScope, this.#active.jobId, "canceled")
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
    this.#frames.setForegroundPressure(pressure);
    this.#visualAnalysis.setForegroundPressure(pressure);
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
        type: workerPressureControl(active.kind, "pause"),
        jobId: active.jobId,
      } satisfies DerivedWorkerRequest);
      return;
    }
    this.#resumeTimer = setTimeout(() => {
      if (this.#active?.jobId === active.jobId) {
        this.#worker?.postMessage({
          type: workerPressureControl(active.kind, "resume"),
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
    const asset = queuedPerceptionAsset(this.#project, this.#snapshot);
    if (!asset) {
      const proxyAsset = queuedProxyAsset(this.#project, this.#snapshot);
      if (proxyAsset) {
        await this.#startProxy(proxyAsset);
        return;
      }
      const transcriptAsset = queuedTranscriptAsset(this.#project, this.#transcriptSnapshot);
      if (transcriptAsset) await this.#startTranscript(transcriptAsset);
      return;
    }
    const record = this.#snapshot.assets[asset.id]!;
    await this.#startPerception(asset, record);
  }

  async #beginPerceptionWriters(
    active: ActiveJob,
    asset: Asset,
    kinds: ReadonlyArray<"thumbnail" | "filmstrip" | "waveform">,
  ): Promise<void> {
    for (const kind of kinds) {
      const writer = await window.cinesim.derived.beginWrite(this.#projectScope, {
        assetId: asset.id,
        kind,
        ...(kind === "waveform"
          ? { expectedBytes: waveformByteLength(waveformPeakCount(asset.durationUs)) }
          : {}),
      });
      active.writers[kind] = writer.writerId;
    }
  }

  #dispatchPerception(
    active: ActiveJob,
    asset: Asset,
    record: NonNullable<DerivedMediaSnapshot["assets"][Asset["id"]]>,
    kinds: Array<"thumbnail" | "filmstrip" | "waveform">,
  ): void {
    this.#worker?.postMessage({
      type: "generate",
      jobId: active.jobId,
      assetId: asset.id,
      projectScope: this.#projectScope,
      durationUs: asset.durationUs,
      kinds,
      ...(record.thumbnail.sourceTimeUs === undefined
        ? {}
        : { thumbnailSourceTimeUs: timeUs(record.thumbnail.sourceTimeUs) }),
    } satisfies DerivedWorkerRequest);
  }

  async #startPerception(
    asset: Asset,
    record: NonNullable<DerivedMediaSnapshot["assets"][Asset["id"]]>,
  ): Promise<void> {
    const kinds = queuedPerceptionKinds(asset, record);
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
      await this.#beginPerceptionWriters(active, asset, kinds);
      await window.cinesim.derived.reportActivity(this.#projectScope, {
        jobId,
        assetId: asset.id,
        jobKind: "perception",
        stage: "scheduled",
        elapsedMs: 0,
      });
      this.#dispatchPerception(active, asset, record, kinds);
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
      const writer = await window.cinesim.derived.beginWrite(this.#projectScope, {
        assetId: asset.id,
        kind: "proxy",
        ...(this.#snapshot?.assets[asset.id]?.proxy.profileId
          ? { profileId: this.#snapshot.assets[asset.id]!.proxy.profileId }
          : {}),
      });
      active.writers.proxy = writer.writerId;
      await window.cinesim.derived.reportActivity(this.#projectScope, {
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
      const { jobId } = await window.cinesim.transcripts.beginJob(this.#projectScope, asset.id);
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
        chunkDurationUs: timeUs(300_000_000),
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

  async #reportWorkerActivity(
    active: ActiveJob,
    message: WorkerResponse<"activity">,
  ): Promise<void> {
    if (active.kind === "transcript") return;
    await window.cinesim.derived.reportActivity(this.#projectScope, {
      jobId: active.jobId,
      assetId: active.assetId,
      jobKind: active.kind,
      stage: message.stage,
      elapsedMs: message.elapsedMs,
      ...(message.completedSamples === undefined
        ? {}
        : { completedSamples: message.completedSamples }),
      ...(message.totalSamples === undefined ? {} : { totalSamples: message.totalSamples }),
    });
  }

  async #updateArtifactProgress(
    active: ActiveJob,
    message: WorkerResponse<"progress">,
  ): Promise<void> {
    const writerId = active.writers[message.stage];
    if (writerId) await window.cinesim.derived.updateProgress(writerId, message.progress);
  }

  #updateTranscriptProgress(
    active: ActiveJob,
    message: WorkerResponse<"transcript-progress">,
  ): void {
    const assetId = active.assetId as Asset["id"];
    const current = this.#transcriptSnapshot?.assets[assetId];
    const nextProgress = Math.max(
      current?.progress ?? 0,
      Math.min(1, Math.max(0, message.progress)),
    );
    if (!current || current.progress === nextProgress || !this.#transcriptSnapshot) return;
    const previousStep = Math.floor((current.progress ?? 0) * TRANSCRIPT_PROGRESS_STEPS);
    const nextStep = Math.floor(nextProgress * TRANSCRIPT_PROGRESS_STEPS);
    const snapshot = structuredClone(this.#transcriptSnapshot);
    const record = snapshot.assets[assetId];
    if (!record) return;
    record.progress = nextProgress;
    this.#transcriptSnapshot = snapshot;
    if (current.progress === undefined || previousStep !== nextStep || nextProgress === 1) {
      this.#notifyTranscriptSnapshot(snapshot);
    }
  }

  async #transcribeChunk(
    active: ActiveJob,
    message: WorkerResponse<"transcript-chunk">,
  ): Promise<void> {
    let error: string | undefined;
    try {
      await window.cinesim.transcripts.transcribeChunk(this.#projectScope, {
        jobId: active.jobId,
        chunkIndex: message.chunkIndex,
        sourceStartUs: message.sourceStartUs,
        sourceEndUs: message.sourceEndUs,
        data: new Uint8Array(message.data),
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Transcript request failed";
    }
    this.#worker?.postMessage({
      type: "transcript-chunk-ack",
      jobId: active.jobId,
      chunkIndex: message.chunkIndex,
      ...(error ? { error } : {}),
    } satisfies DerivedWorkerRequest);
  }

  async #completeTranscript(active: ActiveJob): Promise<void> {
    try {
      const snapshot = await window.cinesim.transcripts.finalizeJob(
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
  }

  async #writeProxyChunk(active: ActiveJob, message: WorkerResponse<"proxy-chunk">): Promise<void> {
    const writerId = active.writers.proxy;
    if (!writerId) return;
    let error: string | undefined;
    try {
      await window.cinesim.derived.writeChunk(
        writerId,
        message.offset,
        new Uint8Array(message.data),
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Proxy write failed";
    }
    this.#worker?.postMessage({
      type: "proxy-chunk-ack",
      jobId: active.jobId,
      chunkId: message.chunkId,
      ...(error ? { error } : {}),
    } satisfies DerivedWorkerRequest);
  }

  async #completeProxy(
    active: ActiveJob,
    message: WorkerResponse<"proxy-complete">,
  ): Promise<void> {
    const writerId = active.writers.proxy;
    if (!writerId) return;
    try {
      await window.cinesim.derived.finalizeWrite(writerId, { bytes: message.bytes });
      delete active.writers.proxy;
      this.#clearWorkerInactivityTimer();
      this.#active = null;
      await this.#schedule();
    } catch {
      await this.#failActive("proxy-finalize-failed");
    }
  }

  async #publishThumbnail(
    active: ActiveJob,
    message: WorkerResponse<"thumbnail-complete">,
  ): Promise<void> {
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
  }

  async #publishFilmstrip(
    active: ActiveJob,
    message: WorkerResponse<"filmstrip-complete">,
  ): Promise<void> {
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
  }

  async #publishWaveform(
    active: ActiveJob,
    message: WorkerResponse<"waveform-complete">,
  ): Promise<void> {
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
  }

  async #completePerception(
    active: ActiveJob,
    message: WorkerResponse<"perception-complete">,
  ): Promise<void> {
    try {
      await window.cinesim.derived.reportPerformance(this.#projectScope, {
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

  async #handleWorkerMessage(message: DerivedWorkerResponse): Promise<void> {
    const active = this.#active;
    if (!active || message.jobId !== active.jobId || this.#destroyed) return;
    if (this.#foregroundPressure === "idle") this.#armWorkerInactivityTimer(active.jobId);
    switch (message.type) {
      case "activity":
        return this.#reportWorkerActivity(active, message);
      case "progress":
        return this.#updateArtifactProgress(active, message);
      case "transcript-progress":
        return this.#updateTranscriptProgress(active, message);
      case "transcript-chunk":
        return this.#transcribeChunk(active, message);
      case "transcript-complete":
        return this.#completeTranscript(active);
      case "proxy-progress": {
        const writerId = active.writers.proxy;
        if (writerId) await window.cinesim.derived.updateProgress(writerId, message.progress);
        return;
      }
      case "proxy-chunk":
        return this.#writeProxyChunk(active, message);
      case "proxy-complete":
        return this.#completeProxy(active, message);
      case "failed":
        return this.#failActive(message.failureCode, message.detail);
      case "thumbnail-complete":
        return this.#publishThumbnail(active, message);
      case "filmstrip-complete":
        return this.#publishFilmstrip(active, message);
      case "waveform-complete":
        return this.#publishWaveform(active, message);
      case "perception-complete":
        return this.#completePerception(active, message);
      case "frame-complete":
        return;
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
      await window.cinesim.derived.writeChunk(
        writerId,
        offset,
        bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)),
      );
    }
    await window.cinesim.derived.finalizeWrite(writerId, { ...metadata, bytes: bytes.byteLength });
    delete active.writers[kind];
  }

  async #failActive(failureCode: string, detail?: string): Promise<void> {
    const active = this.#active;
    this.#clearWorkerInactivityTimer();
    this.#active = null;
    if (!active) return;
    if (active.kind === "transcript") {
      await window.cinesim.transcripts
        .failJob(this.#projectScope, active.jobId, failureCode, detail)
        .then((snapshot) => this.#acceptTranscriptSnapshot(snapshot))
        .catch(() => undefined);
      if (!this.#destroyed) await this.#schedule();
      return;
    }
    await window.cinesim.derived
      .reportActivity(this.#projectScope, {
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
        window.cinesim.derived.cancelWrite(writerId, failureCode, detail).catch(() => undefined),
      ),
    );
    if (!this.#destroyed)
      await window.cinesim.derived
        .get(this.#projectScope)
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

import type { DerivedProjectScope, VisualAnalysisRequest } from "../../shared/contracts";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "./derived-worker-api";
import type { FrameForegroundPressure } from "./frame-job-coordinator";

type VisualComplete = Extract<DerivedWorkerResponse, { type: "visual-index-complete" }>;
type WorkerFailure = Extract<DerivedWorkerResponse, { type: "failed" }>;

export class VisualAnalysisJobCoordinator {
  readonly #projectScope: DerivedProjectScope;
  readonly #queue: VisualAnalysisRequest[] = [];
  #acceptedGeneration: string;
  #active: VisualAnalysisRequest | null = null;
  #worker: Worker | null = null;
  #unsubscribe: (() => void) | null = null;
  #pressure: FrameForegroundPressure = "idle";
  #destroyed = false;

  constructor(projectScope: DerivedProjectScope, acceptedGeneration: string) {
    this.#projectScope = projectScope;
    this.#acceptedGeneration = acceptedGeneration;
  }

  start(): void {
    if (this.#destroyed || this.#unsubscribe) return;
    const unsubscribeRequest = window.cinesim.visualAnalysis.onRequested((request) =>
      this.#enqueue(request),
    );
    const unsubscribeCancel = window.cinesim.visualAnalysis.onCanceled(({ requestId }) =>
      this.#cancel(requestId),
    );
    this.#unsubscribe = () => {
      unsubscribeRequest();
      unsubscribeCancel();
    };
  }

  update(acceptedGeneration: string): void {
    this.#acceptedGeneration = acceptedGeneration;
  }

  setForegroundPressure(pressure: FrameForegroundPressure): void {
    this.#pressure = pressure;
    if (pressure === "idle") this.#schedule();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#queue.length = 0;
    if (this.#active) {
      this.#worker?.postMessage({
        type: "cancel",
        jobId: this.#active.requestId,
      } satisfies DerivedWorkerRequest);
    }
    this.#active = null;
    this.#worker?.terminate();
    this.#worker = null;
  }

  #enqueue(request: VisualAnalysisRequest): void {
    if (this.#destroyed) return;
    if (!this.#matchesAcceptedState(request)) {
      void this.#reportFailure(
        request,
        "stale-visual-analysis-request",
        "The visual-analysis request does not match the accepted renderer generation",
      );
      return;
    }
    if (
      this.#active?.requestId === request.requestId ||
      this.#queue.some((candidate) => candidate.requestId === request.requestId)
    )
      return;
    this.#queue.push(request);
    this.#schedule();
  }

  #matchesAcceptedState(request: VisualAnalysisRequest): boolean {
    return (
      request.projectScope.cacheKey === this.#projectScope.cacheKey &&
      request.projectScope.epoch === this.#projectScope.epoch &&
      (!this.#acceptedGeneration || request.acceptedGeneration === this.#acceptedGeneration)
    );
  }

  #cancel(requestId: string): void {
    const queued = this.#queue.findIndex((request) => request.requestId === requestId);
    if (queued >= 0) this.#queue.splice(queued, 1);
    if (this.#active?.requestId !== requestId) return;
    this.#worker?.postMessage({ type: "cancel", jobId: requestId } satisfies DerivedWorkerRequest);
    this.#active = null;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#destroyed || this.#active || this.#pressure !== "idle") return;
    const request = this.#queue.shift();
    if (!request) return;
    this.#active = request;
    const worker = this.#worker ?? this.#createWorker();
    worker.postMessage({
      type: "visual-index",
      jobId: request.requestId,
      assetId: request.assetId,
      projectScope: this.#projectScope,
      durationUs: request.durationUs,
    } satisfies DerivedWorkerRequest);
  }

  #createWorker(): Worker {
    const worker = new Worker(new URL("../workers/derived-media.worker.ts", import.meta.url), {
      type: "module",
      name: "cinesim-visual-analysis",
    });
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<DerivedWorkerResponse>) => {
      const message = event.data;
      if (message.type === "visual-index-complete") void this.#complete(message);
      else if (message.type === "failed") void this.#fail(message);
    };
    worker.onerror = (event) => {
      if (this.#worker !== worker) return;
      worker.terminate();
      this.#worker = null;
      const active = this.#active;
      if (active)
        void this.#finishFailure(
          active,
          "visual-analysis-worker-crashed",
          event.message || "Visual-analysis worker crashed",
        );
    };
    return worker;
  }

  async #complete(message: VisualComplete): Promise<void> {
    const active = this.#active;
    if (!active || active.requestId !== message.jobId) return;
    try {
      await window.cinesim.visualAnalysis.complete(this.#projectScope, {
        requestId: active.requestId,
        options: message.options,
        coverage: message.coverage,
        observations: message.observations,
      });
      this.#finish(active.requestId);
      this.#schedule();
    } catch (error) {
      await this.#finishFailure(
        active,
        "visual-analysis-publish-failed",
        error instanceof Error ? error.message : "Visual analysis could not be published",
      );
    }
  }

  async #fail(message: WorkerFailure): Promise<void> {
    const active = this.#active;
    if (!active || active.requestId !== message.jobId) return;
    await this.#finishFailure(active, message.failureCode, message.detail);
  }

  async #finishFailure(
    request: VisualAnalysisRequest,
    code: string,
    detail: string,
  ): Promise<void> {
    this.#finish(request.requestId);
    await this.#reportFailure(request, code, detail);
    this.#schedule();
  }

  #finish(requestId: string): void {
    if (this.#active?.requestId === requestId) this.#active = null;
  }

  async #reportFailure(
    request: VisualAnalysisRequest,
    code: string,
    detail: string,
  ): Promise<void> {
    await window.cinesim.visualAnalysis
      .fail(this.#projectScope, { requestId: request.requestId, code, detail })
      .catch(() => undefined);
  }
}

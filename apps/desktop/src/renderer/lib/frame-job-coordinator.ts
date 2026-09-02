import type { Project, ProjectSettings } from "@cinesim/core";
import type { IrProgram } from "@cinesim/ir";
import type { DerivedProjectScope, FrameRenderRequest } from "../../shared/contracts";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "./derived-worker-api";
import { renderTimelineFrame } from "./timeline-frame-renderer";

export type TimelineRenderer = typeof renderTimelineFrame;
export type FrameForegroundPressure =
  | "idle"
  | "hover-skimming"
  | "seeking"
  | "playing"
  | "dragging";
type FrameComplete = Extract<DerivedWorkerResponse, { type: "frame-complete" }>;
type FrameFailure = Extract<DerivedWorkerResponse, { type: "failed" }>;

interface ActiveFrame {
  request: FrameRenderRequest;
  abort: AbortController | null;
}

export class FrameJobCoordinator {
  #project: Project;
  #program: IrProgram | null;
  #acceptedGeneration: string;
  #settings: ProjectSettings;
  readonly #projectScope: DerivedProjectScope;
  readonly #timelineRenderer: TimelineRenderer;
  readonly #queue: FrameRenderRequest[] = [];
  #active: ActiveFrame | null = null;
  #worker: Worker | null = null;
  #unsubscribe: (() => void) | null = null;
  #pressure: FrameForegroundPressure = "idle";
  #destroyed = false;

  constructor(input: {
    project: Project;
    program: IrProgram | null;
    acceptedGeneration: string;
    settings: ProjectSettings;
    projectScope: DerivedProjectScope;
    timelineRenderer?: TimelineRenderer;
  }) {
    this.#project = input.project;
    this.#program = input.program;
    this.#acceptedGeneration = input.acceptedGeneration;
    this.#settings = input.settings;
    this.#projectScope = input.projectScope;
    this.#timelineRenderer = input.timelineRenderer ?? renderTimelineFrame;
  }

  start(): void {
    if (this.#destroyed || this.#unsubscribe) return;
    const unsubscribeRequest = window.cinesim.frames.onRequested((request) =>
      this.#enqueue(request),
    );
    const unsubscribeCancel = window.cinesim.frames.onCanceled(({ requestId }) =>
      this.#cancel(requestId),
    );
    this.#unsubscribe = () => {
      unsubscribeRequest();
      unsubscribeCancel();
    };
  }

  update(
    project: Project,
    program: IrProgram | null,
    acceptedGeneration: string,
    settings: ProjectSettings,
  ): void {
    this.#project = project;
    this.#program = program;
    this.#acceptedGeneration = acceptedGeneration;
    this.#settings = settings;
  }

  setForegroundPressure(pressure: FrameForegroundPressure): void {
    this.#pressure = pressure;
    if (pressure === "idle") void this.#schedule();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#queue.length = 0;
    this.#active?.abort?.abort();
    if (this.#active) {
      this.#worker?.postMessage({
        type: "cancel",
        jobId: this.#active.request.requestId,
      } satisfies DerivedWorkerRequest);
    }
    this.#active = null;
    this.#worker?.terminate();
    this.#worker = null;
  }

  #enqueue(request: FrameRenderRequest): void {
    if (this.#destroyed) return;
    if (!this.#matchesAcceptedState(request)) {
      void this.#reportFailure(
        request,
        "stale-frame-request",
        "The exact-frame request does not match the accepted renderer generation",
      );
      return;
    }
    if (
      this.#active?.request.requestId === request.requestId ||
      this.#queue.some((candidate) => candidate.requestId === request.requestId)
    )
      return;
    this.#queue.push(request);
    void this.#schedule();
  }

  #matchesAcceptedState(request: FrameRenderRequest): boolean {
    return (
      request.projectScope.cacheKey === this.#projectScope.cacheKey &&
      request.projectScope.epoch === this.#projectScope.epoch &&
      (!this.#acceptedGeneration || request.acceptedGeneration === this.#acceptedGeneration)
    );
  }

  #cancel(requestId: string): void {
    const queued = this.#queue.findIndex((request) => request.requestId === requestId);
    if (queued >= 0) this.#queue.splice(queued, 1);
    if (this.#active?.request.requestId !== requestId) return;
    this.#active.abort?.abort();
    this.#worker?.postMessage({ type: "cancel", jobId: requestId } satisfies DerivedWorkerRequest);
    this.#active = null;
    void this.#schedule();
  }

  async #schedule(): Promise<void> {
    if (this.#destroyed || this.#active || this.#pressure !== "idle") return;
    const request = this.#queue.shift();
    if (!request) return;
    if (request.target.kind === "timeline") {
      await this.#startTimeline(request);
      return;
    }
    this.#startAsset(request);
  }

  #startAsset(request: FrameRenderRequest): void {
    if (request.target.kind !== "asset") return;
    const worker = this.#worker ?? this.#createWorker();
    this.#active = { request, abort: null };
    worker.postMessage({
      type: "frame",
      jobId: request.requestId,
      assetId: request.target.assetId,
      projectScope: this.#projectScope,
      atUs: request.normalizedTimeUs,
      width: request.width,
      height: request.height,
    } satisfies DerivedWorkerRequest);
  }

  async #startTimeline(request: FrameRenderRequest): Promise<void> {
    const program = this.#program;
    if (!program) {
      await this.#reportFailure(
        request,
        "accepted-program-unavailable",
        "The accepted timeline program is not available in the renderer",
      );
      await this.#schedule();
      return;
    }
    const abort = new AbortController();
    this.#active = { request, abort };
    try {
      const result = await this.#timelineRenderer({
        project: this.#project,
        settings: this.#settings,
        program,
        projectScope: this.#projectScope,
        request,
        signal: abort.signal,
      });
      if (this.#active?.request.requestId !== request.requestId) return;
      await this.#complete(request, {
        type: "frame-complete",
        jobId: request.requestId,
        ...result,
      });
    } catch (error) {
      if (this.#active?.request.requestId !== request.requestId) return;
      await this.#fail(
        request,
        error instanceof DOMException && error.name === "AbortError"
          ? "canceled"
          : "timeline-frame-failed",
        error instanceof Error ? error.message : "Timeline frame rendering failed",
      );
    }
  }

  #createWorker(): Worker {
    const worker = new Worker(new URL("../workers/derived-media.worker.ts", import.meta.url), {
      type: "module",
      name: "cinesim-exact-frame",
    });
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<DerivedWorkerResponse>) => {
      const message = event.data;
      if (message.type === "frame-complete") void this.#handleComplete(message);
      else if (message.type === "failed") void this.#handleFailure(message);
    };
    worker.onerror = (event) => {
      if (this.#worker !== worker) return;
      worker.terminate();
      this.#worker = null;
      const active = this.#active;
      if (active && active.abort === null)
        void this.#fail(
          active.request,
          "frame-worker-crashed",
          event.message || "Exact-frame worker crashed",
        );
    };
    return worker;
  }

  async #handleComplete(message: FrameComplete): Promise<void> {
    const active = this.#active;
    if (!active || active.request.requestId !== message.jobId) return;
    await this.#complete(active.request, message);
  }

  async #handleFailure(message: FrameFailure): Promise<void> {
    const active = this.#active;
    if (!active || active.request.requestId !== message.jobId) return;
    await this.#fail(active.request, message.failureCode, message.detail);
  }

  async #complete(request: FrameRenderRequest, message: FrameComplete): Promise<void> {
    try {
      await window.cinesim.frames.complete(this.#projectScope, {
        requestId: request.requestId,
        renderedTimeUs: message.renderedTimeUs,
        width: message.width,
        height: message.height,
        png: new Uint8Array(message.frame),
      });
      this.#finish(request.requestId);
      await this.#schedule();
    } catch (error) {
      await this.#fail(
        request,
        "frame-publish-failed",
        error instanceof Error ? error.message : "Exact frame could not be published",
      );
    }
  }

  async #fail(request: FrameRenderRequest, code: string, detail: string): Promise<void> {
    this.#finish(request.requestId);
    await this.#reportFailure(request, code, detail);
    await this.#schedule();
  }

  #finish(requestId: string): void {
    if (this.#active?.request.requestId !== requestId) return;
    this.#active = null;
  }

  async #reportFailure(request: FrameRenderRequest, code: string, detail: string): Promise<void> {
    await window.cinesim.frames
      .fail(this.#projectScope, { requestId: request.requestId, code, detail })
      .catch(() => undefined);
  }
}

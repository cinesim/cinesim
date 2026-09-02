import type { Project, ProjectSettings } from "@cinesim/core";
import type { IrProgram } from "@cinesim/ir";
import type { DerivedProjectScope, ExportRenderRequest } from "../../shared/contracts";
import { renderAcceptedExport } from "./accepted-export-renderer";

export type AcceptedExportRenderer = typeof renderAcceptedExport;

interface ActiveExportRender {
  request: ExportRenderRequest;
  abort: AbortController;
}

export class ExportJobCoordinator {
  #project: Project;
  #program: IrProgram | null;
  #acceptedGeneration: string;
  #settings: ProjectSettings;
  readonly #scope: DerivedProjectScope;
  readonly #renderer: AcceptedExportRenderer;
  #active: ActiveExportRender | null = null;
  #unsubscribe: (() => void) | null = null;
  #destroyed = false;

  constructor(input: {
    project: Project;
    program: IrProgram | null;
    acceptedGeneration: string;
    settings: ProjectSettings;
    scope: DerivedProjectScope;
    renderer?: AcceptedExportRenderer;
  }) {
    this.#project = input.project;
    this.#program = input.program;
    this.#acceptedGeneration = input.acceptedGeneration;
    this.#settings = input.settings;
    this.#scope = input.scope;
    this.#renderer = input.renderer ?? renderAcceptedExport;
  }

  start(): void {
    if (this.#destroyed || this.#unsubscribe) return;
    const request = window.cinesim.exports.onRequested((value) => void this.#start(value));
    const cancel = window.cinesim.exports.onCanceled(({ jobId }) => this.#cancel(jobId));
    this.#unsubscribe = () => {
      request();
      cancel();
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

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#active?.abort.abort();
    this.#active = null;
  }

  async #start(request: ExportRenderRequest): Promise<void> {
    if (this.#destroyed || this.#active) return;
    const accepted = this.#acceptedInput(request);
    if (!accepted) {
      await this.#fail(request.job.id, "stale-export-request", "Export does not match accepted IR");
      return;
    }
    const active = { request, abort: new AbortController() };
    this.#active = active;
    await this.#render(active, accepted);
  }

  #acceptedInput(
    request: ExportRenderRequest,
  ): { project: Project; program: IrProgram; settings: ProjectSettings } | null {
    if (!this.#matchesAcceptedProject(request) || !this.#program) return null;
    return { project: this.#project, program: this.#program, settings: this.#settings };
  }

  async #render(
    active: ActiveExportRender,
    accepted: { project: Project; program: IrProgram; settings: ProjectSettings },
  ): Promise<void> {
    const { request, abort } = active;
    try {
      const completion = await this.#renderer({
        ...accepted,
        request,
        signal: abort.signal,
      });
      if (this.#isActive(request.job.id)) await window.cinesim.exports.complete(completion);
    } catch (error) {
      await this.#failRender(request.job.id, error);
    } finally {
      if (this.#isActive(request.job.id)) this.#active = null;
    }
  }

  async #failRender(jobId: string, error: unknown): Promise<void> {
    if (!this.#isActive(jobId)) return;
    const canceled = error instanceof DOMException && error.name === "AbortError";
    await this.#fail(
      jobId,
      canceled ? "canceled" : "export-render-failed",
      error instanceof Error ? error.message : "Accepted export failed",
    );
  }

  #isActive(jobId: string): boolean {
    return this.#active?.request.job.id === jobId;
  }

  #matchesAcceptedProject(request: ExportRenderRequest): boolean {
    return (
      request.projectScope.cacheKey === this.#scope.cacheKey &&
      request.projectScope.epoch === this.#scope.epoch &&
      request.job.acceptedGeneration === this.#acceptedGeneration
    );
  }

  #cancel(jobId: string): void {
    if (this.#active?.request.job.id === jobId) this.#active.abort.abort();
  }

  async #fail(jobId: string, code: string, detail: string): Promise<void> {
    await window.cinesim.exports.fail({ jobId, code, detail }).catch(() => undefined);
  }
}

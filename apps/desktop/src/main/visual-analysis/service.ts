import type { Asset, Project } from "@cinesim/core";
import type { VisualIndexAssetStatus, VisualIndexStore } from "@cinesim/project-io";
import type {
  DerivedProjectScope,
  VisualAnalysisCompletion,
  VisualAnalysisFailure,
  VisualAnalysisRequest,
} from "../../shared/contracts";

const MAX_VISUAL_ASSETS_PER_REQUEST = 8;
const VISUAL_ANALYSIS_TIMEOUT_MS = 120_000;

interface OpenVisualProject {
  project: Project;
  acceptedGeneration: string;
  scope: DerivedProjectScope;
}

interface PendingVisualAnalysis {
  request: VisualAnalysisRequest;
  resolve: (status: VisualIndexAssetStatus) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  redispatch: ReturnType<typeof setInterval>;
}

export class VisualAnalysisService {
  #open: OpenVisualProject | null = null;
  readonly #pending = new Map<string, PendingVisualAnalysis>();
  readonly #inFlightByAsset = new Map<string, Promise<VisualIndexAssetStatus>>();

  constructor(
    private readonly store: VisualIndexStore,
    private readonly dispatch: (request: VisualAnalysisRequest) => boolean,
    private readonly cancelDispatch: (requestId: string) => void = () => undefined,
  ) {}

  setProject(input: OpenVisualProject): void {
    this.#cancelAll("The open project changed");
    this.#inFlightByAsset.clear();
    this.#open = structuredClone(input);
  }

  clearProject(): void {
    this.#cancelAll("The project was closed");
    this.#inFlightByAsset.clear();
    this.#open = null;
  }

  async generate(assetIds: readonly string[], force = false): Promise<VisualIndexAssetStatus[]> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0 || ids.length > MAX_VISUAL_ASSETS_PER_REQUEST)
      throw new Error(`Visual analysis requires 1 to ${MAX_VISUAL_ASSETS_PER_REQUEST} assets`);
    for (const assetId of ids) await this.#generateAsset(assetId, force);
    return this.store.status(ids);
  }

  async complete(scope: DerivedProjectScope, completion: VisualAnalysisCompletion): Promise<void> {
    const pending = this.#pending.get(completion.requestId);
    if (!pending) throw new Error("Unknown or expired visual-analysis request");
    this.#assertScope(scope);
    try {
      const status = await this.store.replaceGenerated(pending.request.assetId, completion);
      this.#settle(pending.request.requestId);
      pending.resolve(status);
    } catch (error) {
      this.#reject(pending, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  fail(scope: DerivedProjectScope, failure: VisualAnalysisFailure): void {
    this.#assertScope(scope);
    const pending = this.#pending.get(failure.requestId);
    if (!pending) return;
    this.#reject(pending, new Error(`${failure.code}: ${failure.detail}`));
  }

  async #generateAsset(assetId: string, force: boolean): Promise<VisualIndexAssetStatus> {
    const asset = this.#visualAsset(assetId);
    const [status] = await this.store.status([assetId]);
    if (!force && status?.state === "current" && status.observationCount > 0) return status;
    const existing = this.#inFlightByAsset.get(assetId);
    if (existing) return existing;
    const operation = this.#request(asset);
    this.#inFlightByAsset.set(assetId, operation);
    try {
      return await operation;
    } finally {
      if (this.#inFlightByAsset.get(assetId) === operation) this.#inFlightByAsset.delete(assetId);
    }
  }

  #visualAsset(assetId: string): Asset {
    const asset = this.#requireOpen().project.assets.find(({ id }) => id === assetId);
    if (!asset) throw new Error(`Unknown asset: ${assetId}`);
    if (asset.kind !== "video") throw new Error("Automatic visual analysis requires a video asset");
    if (asset.technical?.video?.decoderAvailability === "unsupported")
      throw new Error("The asset is known to be undecodable in the active runtime");
    return asset;
  }

  #request(asset: Asset): Promise<VisualIndexAssetStatus> {
    const open = this.#requireOpen();
    const request: VisualAnalysisRequest = {
      requestId: crypto.randomUUID(),
      projectScope: open.scope,
      assetId: asset.id,
      durationUs: asset.durationUs,
      acceptedGeneration: open.acceptedGeneration,
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(request.requestId);
        if (!pending) return;
        this.cancelDispatch(request.requestId);
        this.#reject(pending, new Error("Visual analysis timed out"));
      }, VISUAL_ANALYSIS_TIMEOUT_MS);
      const redispatch = setInterval(() => {
        if (this.#pending.has(request.requestId)) this.dispatch(request);
      }, 500);
      this.#pending.set(request.requestId, { request, resolve, reject, timeout, redispatch });
      if (!this.dispatch(request)) {
        const pending = this.#pending.get(request.requestId);
        if (pending) this.#reject(pending, new Error("Visual analysis requires an open renderer"));
      }
    });
  }

  #assertScope(scope: DerivedProjectScope): void {
    const open = this.#requireOpen();
    if (scope.cacheKey !== open.scope.cacheKey || scope.epoch !== open.scope.epoch)
      throw new Error("Stale visual-analysis project scope");
  }

  #requireOpen(): OpenVisualProject {
    if (!this.#open) throw new Error("No visual-analysis project is open");
    return this.#open;
  }

  #settle(requestId: string): PendingVisualAnalysis | undefined {
    const pending = this.#pending.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timeout);
    clearInterval(pending.redispatch);
    this.#pending.delete(requestId);
    return pending;
  }

  #reject(pending: PendingVisualAnalysis, error: Error): void {
    this.#settle(pending.request.requestId);
    pending.reject(error);
  }

  #cancelAll(detail: string): void {
    for (const pending of this.#pending.values()) {
      this.cancelDispatch(pending.request.requestId);
      this.#reject(pending, new Error(detail));
    }
  }
}

import type { Asset, Project } from "@cinesim/core";
import type {
  DerivedArtifactKind,
  DerivedMediaSnapshot,
  FinalizeDerivedWrite,
} from "../../shared/api";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "./derived-worker-api";

interface ActiveJob {
  jobId: string;
  assetId: string;
  writers: Partial<Record<"thumbnail" | "filmstrip", string>>;
}

export class MediaJobCoordinator {
  #project: Project;
  #snapshot: DerivedMediaSnapshot | null = null;
  #worker: Worker | null = null;
  #active: ActiveJob | null = null;
  #unsubscribe: (() => void) | null = null;
  #destroyed = false;
  readonly #onSnapshot: (snapshot: DerivedMediaSnapshot) => void;

  constructor(project: Project, onSnapshot: (snapshot: DerivedMediaSnapshot) => void) {
    this.#project = project;
    this.#onSnapshot = onSnapshot;
  }

  async start(): Promise<void> {
    if (this.#destroyed || this.#worker) return;
    this.#worker = new Worker(new URL("../workers/derived-media.worker.ts", import.meta.url), {
      type: "module",
      name: "cinesim-derived-media",
    });
    this.#worker.onmessage = (event: MessageEvent<DerivedWorkerResponse>) => {
      void this.#handleWorkerMessage(event.data);
    };
    this.#worker.onerror = () => {
      if (this.#active) void this.#failActive("worker-crashed");
    };
    this.#unsubscribe = window.cinesim.onDerivedMediaChanged((snapshot) => {
      this.#acceptSnapshot(snapshot);
    });
    this.#acceptSnapshot(await window.cinesim.getDerivedMediaSnapshot());
    await this.updateProject(this.#project);
  }

  async updateProject(project: Project): Promise<void> {
    this.#project = project;
    if (this.#destroyed) return;
    const videoIds = project.assets
      .filter((asset) => asset.kind === "video")
      .map((asset) => asset.id);
    this.#acceptSnapshot(await window.cinesim.requestDerivedJobs(videoIds));
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
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

  #acceptSnapshot(snapshot: DerivedMediaSnapshot): void {
    if (this.#destroyed) return;
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
    if (!asset) return;
    const record = this.#snapshot.assets[asset.id]!;
    const kinds = (["thumbnail", "filmstrip"] as const).filter(
      (kind) => record[kind].state === "queued",
    );
    const jobId = crypto.randomUUID();
    const active: ActiveJob = { jobId, assetId: asset.id, writers: {} };
    this.#active = active;
    try {
      for (const kind of kinds) {
        const writer = await window.cinesim.beginDerivedWrite({ assetId: asset.id, kind });
        active.writers[kind] = writer.writerId;
      }
      this.#worker.postMessage({
        type: "generate",
        jobId,
        assetId: asset.id,
        durationUs: asset.durationUs,
      } satisfies DerivedWorkerRequest);
    } catch {
      await this.#failActive("job-start-failed");
    }
  }

  async #handleWorkerMessage(message: DerivedWorkerResponse): Promise<void> {
    const active = this.#active;
    if (!active || message.jobId !== active.jobId || this.#destroyed) return;
    if (message.type === "progress") {
      const writerId = active.writers[message.stage];
      if (writerId) await window.cinesim.updateDerivedProgress(writerId, message.progress);
      return;
    }
    if (message.type === "failed") {
      await this.#failActive(message.failureCode);
      return;
    }
    try {
      await this.#publish("thumbnail", message.thumbnail, active, {
        sourceTimeUs: message.sourceTimeUs,
      });
      await this.#publish("filmstrip", message.filmstrip, active, {
        tileTimesUs: message.tileTimesUs,
        columns: message.columns,
        rows: message.rows,
        tileWidth: message.tileWidth,
        tileHeight: message.tileHeight,
      });
      await window.cinesim.reportDerivedPerformance({
        assetId: active.assetId,
        sourceKind: "original",
        operation: "sampling",
        latencyMs: message.samplingLatencyMs,
      });
      this.#active = null;
      await this.#schedule();
    } catch {
      await this.#failActive("artifact-write-failed");
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

  async #failActive(failureCode: string): Promise<void> {
    const active = this.#active;
    this.#active = null;
    if (!active) return;
    await Promise.all(
      Object.values(active.writers).map((writerId) =>
        window.cinesim.cancelDerivedWrite(writerId, failureCode).catch(() => undefined),
      ),
    );
    if (!this.#destroyed) await this.#schedule();
  }
}

export function derivedArtifactUrl(
  kind: Exclude<DerivedArtifactKind, "proxy">,
  asset: Pick<Asset, "id">,
  generatorVersion = "1",
): string {
  return `cinesim-media://${kind}/${asset.id}?v=${encodeURIComponent(generatorVersion)}`;
}

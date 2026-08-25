import { createCinesimLogger } from "@cinesim/logging";
import type {
  DerivedProjectScope,
  DerivedRuntimeSnapshot,
  DerivedWorkerActivity,
} from "../../shared/api";
import { emptyRuntime } from "./model";

const log = createCinesimLogger({ service: "derived-media" });

export class DerivedRuntimeTracker {
  #runtime = emptyRuntime();
  #emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChanged: () => void,
    private readonly currentScope: () => DerivedProjectScope | null,
  ) {}

  reset(): void {
    this.#runtime = emptyRuntime();
    if (this.#emitTimer) clearTimeout(this.#emitTimer);
    this.#emitTimer = null;
  }

  snapshot(): DerivedRuntimeSnapshot {
    return structuredClone(this.#runtime);
  }

  updateWriterProgress(assetId: string, progress: number): void {
    const active = this.#runtime.activeJob;
    if (!active || active.assetId !== assetId) return;
    active.progress = progress;
    active.lastActivityAt = new Date().toISOString();
  }

  reportActivity(activity: DerivedWorkerActivity): void {
    const now = new Date().toISOString();
    if (activity.stage === "scheduled" || this.#runtime.activeJob?.jobId !== activity.jobId) {
      this.#runtime.activeJob = {
        jobId: activity.jobId,
        assetId: activity.assetId,
        jobKind: activity.jobKind,
        stage: activity.stage,
        progress:
          activity.completedSamples !== undefined && activity.totalSamples
            ? activity.completedSamples / activity.totalSamples
            : 0,
        elapsedMs: activity.elapsedMs,
        startedAt: now,
        lastActivityAt: now,
        ...(activity.completedSamples !== undefined
          ? { completedSamples: activity.completedSamples }
          : {}),
        ...(activity.totalSamples !== undefined ? { totalSamples: activity.totalSamples } : {}),
      };
    } else {
      const active = this.#runtime.activeJob;
      active.stage = activity.stage;
      active.elapsedMs = activity.elapsedMs;
      active.lastActivityAt = now;
      if (activity.completedSamples !== undefined)
        active.completedSamples = activity.completedSamples;
      if (activity.totalSamples !== undefined) active.totalSamples = activity.totalSamples;
      if (activity.completedSamples !== undefined && activity.totalSamples)
        active.progress = activity.completedSamples / activity.totalSamples;
    }
    log.info(
      {
        operation: "worker-activity",
        jobId: activity.jobId,
        assetId: activity.assetId,
        jobKind: activity.jobKind,
        stage: activity.stage,
        elapsedMs: activity.elapsedMs,
        ...(activity.completedSamples !== undefined
          ? { completedSamples: activity.completedSamples }
          : {}),
        ...(activity.totalSamples !== undefined ? { totalSamples: activity.totalSamples } : {}),
        ...(activity.failureCode ? { failureCode: activity.failureCode } : {}),
        ...(activity.detail ? { detail: activity.detail } : {}),
      },
      "derived worker activity",
    );
    if (activity.stage === "completed" || activity.stage === "failed") {
      this.#runtime.lastJob = {
        assetId: activity.assetId,
        jobKind: activity.jobKind,
        stage: activity.stage,
        durationMs: activity.elapsedMs,
        finishedAt: now,
        ...(activity.failureCode ? { failureCode: activity.failureCode } : {}),
      };
      delete this.#runtime.activeJob;
    }
    this.onChanged();
  }

  recordProtocolRead(input: {
    assetId: string;
    start: number;
    requestedEnd: number;
    bytesRead: number;
    durationMs: number;
    range: boolean;
  }): void {
    const protocol = this.#runtime.protocol;
    protocol.requests += 1;
    protocol.rangeRequests += Number(input.range);
    protocol.bytesRead += input.bytesRead;
    protocol.averageLatencyMs += (input.durationMs - protocol.averageLatencyMs) / protocol.requests;
    protocol.lastLatencyMs = input.durationMs;
    protocol.lastBytesRead = input.bytesRead;
    protocol.lastAssetId = input.assetId;
    const scope = this.currentScope();
    log.info(
      {
        operation: "protocol-read",
        projectCacheKey: scope?.cacheKey,
        projectEpoch: scope?.epoch,
        assetId: input.assetId,
        start: input.start,
        requestedEnd: input.requestedEnd,
        bytesRead: input.bytesRead,
        durationMs: input.durationMs,
        range: input.range,
      },
      "media protocol range served",
    );
    this.#scheduleEmit();
  }

  recordProtocolError(assetId: string | undefined, detail: string, durationMs: number): void {
    this.#runtime.protocol.errors += 1;
    const scope = this.currentScope();
    log.error(
      {
        operation: "protocol-error",
        projectCacheKey: scope?.cacheKey,
        projectEpoch: scope?.epoch,
        ...(assetId ? { assetId } : {}),
        detail,
        durationMs,
      },
      "media protocol request failed",
    );
    this.#scheduleEmit();
  }

  #scheduleEmit(): void {
    if (this.#emitTimer) return;
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      this.onChanged();
    }, 250);
  }
}

import type { DerivedPerformanceObservation } from "../../shared/contracts";
import { emptyPerformance, percentile } from "./model";
import type { PersistedAsset } from "./model";

export class DerivedPerformanceTracker {
  readonly #latencies = new Map<string, number[]>();
  readonly #deadlines = new Map<string, { total: number; missed: number }>();

  reset(): void {
    this.#latencies.clear();
    this.#deadlines.clear();
  }

  remove(assetId: string): void {
    this.#latencies.delete(`${assetId}:original`);
    this.#latencies.delete(`${assetId}:proxy`);
    this.#deadlines.delete(`${assetId}:original`);
    this.#deadlines.delete(`${assetId}:proxy`);
  }

  record(record: PersistedAsset, observation: DerivedPerformanceObservation): void {
    const summary =
      observation.sourceKind === "proxy"
        ? (record.performance.proxy ??= emptyPerformance())
        : record.performance.original;
    summary.observations += 1;
    summary.requestsReceived += observation.requestsReceived ?? 0;
    summary.requestsCoalesced += observation.requestsCoalesced ?? 0;
    summary.framesPresented += observation.framesPresented ?? 0;
    summary.framesObsolete += observation.framesObsolete ?? 0;
    const key = `${observation.assetId}:${observation.sourceKind}`;
    if (observation.latencyMs !== undefined && observation.operation === "hover-seek") {
      if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0) {
        throw new Error("Invalid media latency");
      }
      const values = this.#latencies.get(key) ?? [];
      values.push(observation.latencyMs);
      if (values.length > 64) values.shift();
      this.#latencies.set(key, values);
      const p50 = percentile(values, 0.5);
      const p95 = percentile(values, 0.95);
      if (p50 === undefined || p95 === undefined) {
        throw new Error("Media latency sample was not retained");
      }
      summary.warmSeekP50Ms = p50;
      summary.warmSeekP95Ms = p95;
    }
    if (observation.deadlineMiss !== undefined) {
      const deadlines = this.#deadlines.get(key) ?? { total: 0, missed: 0 };
      deadlines.total += 1;
      deadlines.missed += Number(observation.deadlineMiss);
      if (deadlines.total > 100) {
        deadlines.total = Math.ceil(deadlines.total / 2);
        deadlines.missed = Math.ceil(deadlines.missed / 2);
      }
      this.#deadlines.set(key, deadlines);
      summary.deadlineMissRate = deadlines.missed / deadlines.total;
    }
  }
}

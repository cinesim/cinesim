import type { DerivedPerformanceObservation } from "../../shared/contracts";
import { emptyPerformance, percentile } from "./model";
import type { PersistedAsset } from "./model";

type PerformanceSummary = PersistedAsset["performance"]["original"];
type DeadlineWindow = { total: number; missed: number };

function observationKey(observation: DerivedPerformanceObservation): string {
  return `${observation.assetId}:${observation.sourceKind}`;
}

function performanceSummary(
  record: PersistedAsset,
  sourceKind: DerivedPerformanceObservation["sourceKind"],
): PerformanceSummary {
  return sourceKind === "proxy"
    ? (record.performance.proxy ??= emptyPerformance())
    : record.performance.original;
}

function recordCounters(
  summary: PerformanceSummary,
  observation: DerivedPerformanceObservation,
): void {
  summary.observations += 1;
  summary.requestsReceived += observation.requestsReceived ?? 0;
  summary.requestsCoalesced += observation.requestsCoalesced ?? 0;
  summary.framesPresented += observation.framesPresented ?? 0;
  summary.framesObsolete += observation.framesObsolete ?? 0;
}

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
    const summary = performanceSummary(record, observation.sourceKind);
    const key = observationKey(observation);
    recordCounters(summary, observation);
    this.#recordLatency(key, summary, observation);
    this.#recordDeadline(key, summary, observation.deadlineMiss);
  }

  #recordLatency(
    key: string,
    summary: PerformanceSummary,
    observation: DerivedPerformanceObservation,
  ): void {
    if (observation.latencyMs === undefined || observation.operation !== "hover-seek") return;
    if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0)
      throw new Error("Invalid media latency");

    const values = this.#latencies.get(key) ?? [];
    values.push(observation.latencyMs);
    if (values.length > 64) values.shift();
    this.#latencies.set(key, values);

    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    if (p50 === undefined || p95 === undefined)
      throw new Error("Media latency sample was not retained");
    summary.warmSeekP50Ms = p50;
    summary.warmSeekP95Ms = p95;
  }

  #recordDeadline(key: string, summary: PerformanceSummary, missed: boolean | undefined): void {
    if (missed === undefined) return;
    const window = this.#deadlines.get(key) ?? { total: 0, missed: 0 };
    window.total += 1;
    window.missed += Number(missed);
    this.#shrinkDeadlineWindow(window);
    this.#deadlines.set(key, window);
    summary.deadlineMissRate = window.missed / window.total;
  }

  #shrinkDeadlineWindow(window: DeadlineWindow): void {
    if (window.total <= 100) return;
    window.total = Math.ceil(window.total / 2);
    window.missed = Math.ceil(window.missed / 2);
  }
}

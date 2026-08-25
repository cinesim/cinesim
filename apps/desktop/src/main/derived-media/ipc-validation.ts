import type {
  DerivedProjectScope,
  DerivedWorkerActivity,
  DerivedWorkerStage,
} from "../../shared/api";

const DERIVED_WORKER_STAGES = new Set<DerivedWorkerStage>([
  "scheduled",
  "input-opening",
  "container-ready",
  "track-ready",
  "decoder-ready",
  "thumbnail-sampling",
  "thumbnail-encoding",
  "thumbnail-ready",
  "filmstrip-sampling",
  "filmstrip-encoding",
  "filmstrip-ready",
  "waveform-decoding",
  "waveform-encoding",
  "waveform-ready",
  "proxy-converting",
  "completed",
  "failed",
]);

export function parseDerivedProjectScope(value: unknown): DerivedProjectScope {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid derived media project scope");
  const input = value as Record<string, unknown>;
  if (
    typeof input.cacheKey !== "string" ||
    !/^[a-f0-9]{24}$/.test(input.cacheKey) ||
    typeof input.epoch !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.epoch)
  )
    throw new Error("Invalid derived media project scope");
  return { cacheKey: input.cacheKey, epoch: input.epoch };
}

export function parseDerivedWorkerActivity(value: unknown): DerivedWorkerActivity {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid derived worker activity");
  const input = value as Record<string, unknown>;
  if (
    typeof input.jobId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.jobId) ||
    typeof input.assetId !== "string" ||
    !/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.assetId) ||
    (input.jobKind !== "perception" && input.jobKind !== "proxy") ||
    typeof input.stage !== "string" ||
    !DERIVED_WORKER_STAGES.has(input.stage as DerivedWorkerStage) ||
    typeof input.elapsedMs !== "number" ||
    !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs < 0 ||
    input.elapsedMs > 86_400_000
  )
    throw new Error("Invalid derived worker activity");
  for (const sample of [input.completedSamples, input.totalSamples]) {
    if (sample !== undefined && (!Number.isSafeInteger(sample) || (sample as number) < 0))
      throw new Error("Invalid derived worker sample count");
  }
  if (
    input.failureCode !== undefined &&
    (typeof input.failureCode !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.failureCode))
  )
    throw new Error("Invalid derived worker failure code");
  if (
    input.detail !== undefined &&
    (typeof input.detail !== "string" || input.detail.length > 2_000)
  )
    throw new Error("Invalid derived worker detail");
  return input as unknown as DerivedWorkerActivity;
}

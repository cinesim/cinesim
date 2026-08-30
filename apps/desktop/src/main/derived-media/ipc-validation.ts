import { z } from "zod";
import { assetIdSchema } from "@cinesim/protocol";
import type {
  BeginDerivedWrite,
  DerivedPerformanceObservation,
  DerivedProjectScope,
  DerivedWorkerActivity,
  FinalizeDerivedWrite,
} from "../../shared/contracts";

const safeNonnegative = z.number().int().nonnegative().safe();
const boundedCount = safeNonnegative.max(1_000_000_000);
export const derivedProjectScopeSchema = z
  .object({
    cacheKey: z.string().regex(/^[a-f0-9]{24}$/u),
    epoch: z.string().uuid(),
  })
  .transform((value): DerivedProjectScope => value);

export const derivedWorkerActivitySchema = z
  .object({
    jobId: z.string().uuid(),
    assetId: assetIdSchema,
    jobKind: z.enum(["perception", "proxy"]),
    stage: z.enum([
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
    ]),
    elapsedMs: z.number().nonnegative().finite().max(86_400_000),
    completedSamples: boundedCount.optional(),
    totalSamples: boundedCount.optional(),
    failureCode: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
      .optional(),
    detail: z.string().max(2_000).optional(),
  })
  .transform((value): DerivedWorkerActivity => ({
    jobId: value.jobId,
    assetId: value.assetId,
    jobKind: value.jobKind,
    stage: value.stage,
    elapsedMs: value.elapsedMs,
    ...(value.completedSamples !== undefined ? { completedSamples: value.completedSamples } : {}),
    ...(value.totalSamples !== undefined ? { totalSamples: value.totalSamples } : {}),
    ...(value.failureCode !== undefined ? { failureCode: value.failureCode } : {}),
    ...(value.detail !== undefined ? { detail: value.detail } : {}),
  }));

export const beginDerivedWriteSchema = z
  .object({
    assetId: assetIdSchema,
    kind: z.enum(["thumbnail", "filmstrip", "waveform", "proxy"]),
    expectedBytes: z.number().int().positive().safe().optional(),
    profileId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
      .optional(),
  })
  .transform((value): BeginDerivedWrite => ({
    assetId: value.assetId,
    kind: value.kind,
    ...(value.expectedBytes !== undefined ? { expectedBytes: value.expectedBytes } : {}),
    ...(value.profileId !== undefined ? { profileId: value.profileId } : {}),
  }));

export const finalizeDerivedWriteSchema = z
  .object({
    bytes: z.number().int().positive().safe(),
    sourceTimeUs: safeNonnegative.optional(),
    tileTimesUs: z.array(safeNonnegative).max(64).optional(),
    columns: safeNonnegative.optional(),
    rows: safeNonnegative.optional(),
    tileWidth: safeNonnegative.optional(),
    tileHeight: safeNonnegative.optional(),
    peakCount: safeNonnegative.optional(),
    waveformFormatVersion: safeNonnegative.optional(),
  })
  .transform((value): FinalizeDerivedWrite => ({
    bytes: value.bytes,
    ...(value.sourceTimeUs !== undefined ? { sourceTimeUs: value.sourceTimeUs } : {}),
    ...(value.tileTimesUs !== undefined ? { tileTimesUs: value.tileTimesUs } : {}),
    ...(value.columns !== undefined ? { columns: value.columns } : {}),
    ...(value.rows !== undefined ? { rows: value.rows } : {}),
    ...(value.tileWidth !== undefined ? { tileWidth: value.tileWidth } : {}),
    ...(value.tileHeight !== undefined ? { tileHeight: value.tileHeight } : {}),
    ...(value.peakCount !== undefined ? { peakCount: value.peakCount } : {}),
    ...(value.waveformFormatVersion !== undefined
      ? { waveformFormatVersion: value.waveformFormatVersion }
      : {}),
  }));

export const derivedPerformanceObservationSchema = z
  .object({
    assetId: assetIdSchema,
    sourceKind: z.enum(["original", "proxy"]),
    operation: z.enum(["sampling", "hover-seek", "playback"]),
    latencyMs: z.number().nonnegative().finite().optional(),
    deadlineMiss: z.boolean().optional(),
    requestsReceived: boundedCount.optional(),
    requestsCoalesced: boundedCount.optional(),
    framesPresented: boundedCount.optional(),
    framesObsolete: boundedCount.optional(),
  })
  .transform((value): DerivedPerformanceObservation => ({
    assetId: value.assetId,
    sourceKind: value.sourceKind,
    operation: value.operation,
    ...(value.latencyMs !== undefined ? { latencyMs: value.latencyMs } : {}),
    ...(value.deadlineMiss !== undefined ? { deadlineMiss: value.deadlineMiss } : {}),
    ...(value.requestsReceived !== undefined ? { requestsReceived: value.requestsReceived } : {}),
    ...(value.requestsCoalesced !== undefined
      ? { requestsCoalesced: value.requestsCoalesced }
      : {}),
    ...(value.framesPresented !== undefined ? { framesPresented: value.framesPresented } : {}),
    ...(value.framesObsolete !== undefined ? { framesObsolete: value.framesObsolete } : {}),
  }));

export function parseDerivedProjectScope(value: unknown): DerivedProjectScope {
  return derivedProjectScopeSchema.parse(value);
}

export function parseDerivedWorkerActivity(value: unknown): DerivedWorkerActivity {
  return derivedWorkerActivitySchema.parse(value);
}

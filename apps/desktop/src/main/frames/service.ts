import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sequenceDurationUs, timeUs } from "@cinesim/core";
import type { Asset, Project, Sequence, TimeUs } from "@cinesim/core";
import {
  derivedFrameArtifactBaseName,
  normalizeDerivedFrameTime,
  ProjectPaths,
  projectSourceFingerprintsEqual,
} from "@cinesim/project-io";
import { z } from "zod";
import type {
  DerivedProjectScope,
  FrameArtifact,
  FrameQuality,
  FrameRenderCompletion,
  FrameRenderFailure,
  FrameRenderRequest,
  FrameTarget,
  SourceFingerprint,
} from "../../shared/contracts";
import { FRAME_QUALITY_LIMITS } from "../../shared/contracts";

export const FRAME_GENERATOR_VERSION = "frame-v1";
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_FRAMES = 8;
const FRAME_TIMEOUT_MS = 45_000;

interface OpenFrameProject {
  directory: string;
  project: Project;
  acceptedGeneration: string;
  scope: DerivedProjectScope;
}

interface PendingFrame {
  request: FrameRenderRequest;
  path: string;
  metadataPath: string;
  sourceFingerprint?: SourceFingerprint | undefined;
  resolve: (artifact: FrameArtifact) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  redispatch: ReturnType<typeof setInterval>;
}

interface FrameSpecification {
  normalizedTimeUs: TimeUs;
  width: number;
  height: number;
  asset?: Asset | undefined;
}

const fingerprintSchema = z
  .object({ size: z.number(), mtimeMs: z.number(), edgeHash: z.string() })
  .strict();
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: z.string() }).strict(),
  z.object({ kind: z.literal("timeline"), sequenceId: z.string() }).strict(),
]);
const persistedFrameSchema = z
  .object({
    version: z.literal(1),
    generatorVersion: z.literal(FRAME_GENERATOR_VERSION),
    target: targetSchema,
    quality: z.enum(["low", "medium", "high"]),
    normalizedTimeUs: z.number().int().nonnegative(),
    renderedTimeUs: z.number().int().nonnegative(),
    width: z.number().int().positive().max(FRAME_QUALITY_LIMITS.high),
    height: z.number().int().positive().max(FRAME_QUALITY_LIMITS.high),
    bytes: z.number().int().positive().max(MAX_FRAME_BYTES),
    sourceFingerprint: fingerprintSchema.optional(),
    acceptedGeneration: z.string().optional(),
  })
  .strict();

type PersistedFrame = z.infer<typeof persistedFrameSchema>;

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function boundedFrameSize(
  width: number,
  height: number,
  quality: FrameQuality,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const limit = FRAME_QUALITY_LIMITS[quality];
  const scale = Math.min(1, limit / Math.max(safeWidth, safeHeight));
  return { width: even(safeWidth * scale), height: even(safeHeight * scale) };
}

function sameTarget(left: FrameTarget, right: FrameTarget): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "asset"
    ? left.assetId === (right as Extract<FrameTarget, { kind: "asset" }>).assetId
    : left.sequenceId === (right as Extract<FrameTarget, { kind: "timeline" }>).sequenceId;
}

function frameRateForAsset(asset: Asset): number {
  return asset.technical?.video?.frameRate.nominal || asset.frameRate || 30;
}

function sequenceFor(project: Project, sequenceId: string): Sequence {
  const sequence = project.sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) throw new Error(`Unknown timeline: ${sequenceId}`);
  return sequence;
}

function publicArtifact(
  persisted: PersistedFrame,
  input: { path: string; metadataPath: string; requestedTimeUs: TimeUs; cached: boolean },
): FrameArtifact {
  const { sourceFingerprint, acceptedGeneration, ...required } = persisted;
  return {
    ...required,
    normalizedTimeUs: timeUs(persisted.normalizedTimeUs),
    renderedTimeUs: timeUs(persisted.renderedTimeUs),
    requestedTimeUs: input.requestedTimeUs,
    path: input.path,
    metadataPath: input.metadataPath,
    cached: input.cached,
    derived: true,
    ...(sourceFingerprint ? { sourceFingerprint } : {}),
    ...(acceptedGeneration ? { acceptedGeneration } : {}),
  };
}

/** Owns disposable frame artifacts; decoding and composition remain renderer-local. */
export class FrameService {
  #open: OpenFrameProject | null = null;
  readonly #pending = new Map<string, PendingFrame>();
  readonly #inFlightByName = new Map<string, Promise<FrameArtifact>>();

  constructor(
    private readonly dispatch: (request: FrameRenderRequest) => boolean,
    private readonly sourceFingerprint: (assetId: string) => Promise<SourceFingerprint>,
    private readonly cancelDispatch: (requestId: string) => void = () => undefined,
  ) {}

  setProject(input: OpenFrameProject): void {
    this.#cancelAll("The open project changed");
    this.#inFlightByName.clear();
    this.#open = structuredClone(input);
  }

  clearProject(): void {
    this.#cancelAll("The project was closed");
    this.#inFlightByName.clear();
    this.#open = null;
  }

  async get(
    target: FrameTarget,
    requestedAtUs: number,
    quality: FrameQuality = "medium",
  ): Promise<FrameArtifact> {
    const open = this.#requireOpen();
    const requestedTimeUs = timeUs(Math.round(requestedAtUs));
    const specification = this.#specification(open, target, requestedTimeUs, quality);
    const name = derivedFrameArtifactBaseName(target, specification.normalizedTimeUs, quality);
    const existing = this.#inFlightByName.get(name);
    if (existing) return this.#withRequestedTime(existing, requestedTimeUs);
    if (this.#pending.size >= MAX_PENDING_FRAMES)
      throw new Error("Too many exact-frame requests are pending");
    const operation = this.#getOrRender(open, target, requestedTimeUs, quality, specification);
    this.#inFlightByName.set(name, operation);
    try {
      return await operation;
    } finally {
      if (this.#inFlightByName.get(name) === operation) this.#inFlightByName.delete(name);
    }
  }

  async complete(scope: DerivedProjectScope, completion: FrameRenderCompletion): Promise<void> {
    const pending = this.#pending.get(completion.requestId);
    if (!pending) throw new Error("Unknown or expired frame request");
    this.#assertScope(scope);
    try {
      this.#validateCompletion(pending, completion);
      const persisted = this.#persisted(pending, completion);
      await this.#publish(pending, persisted, completion.png);
      this.#settle(pending.request.requestId);
      pending.resolve(
        publicArtifact(persisted, {
          path: pending.path,
          metadataPath: pending.metadataPath,
          requestedTimeUs: pending.request.requestedTimeUs,
          cached: false,
        }),
      );
    } catch (error) {
      this.#rejectPending(pending, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  fail(scope: DerivedProjectScope, failure: FrameRenderFailure): void {
    this.#assertScope(scope);
    const pending = this.#pending.get(failure.requestId);
    if (!pending) return;
    this.#rejectPending(pending, new Error(`${failure.code}: ${failure.detail}`));
  }

  #specification(
    open: OpenFrameProject,
    target: FrameTarget,
    requestedTimeUs: TimeUs,
    quality: FrameQuality,
  ): FrameSpecification {
    if (target.kind === "asset") {
      const asset = open.project.assets.find((candidate) => candidate.id === target.assetId);
      if (!asset) throw new Error(`Unknown asset: ${target.assetId}`);
      if (asset.kind !== "video") throw new Error("Exact frames currently require a video asset");
      if (asset.technical?.video?.decoderAvailability === "unsupported")
        throw new Error("The asset is known to be undecodable in the active runtime");
      return {
        asset,
        normalizedTimeUs: normalizeDerivedFrameTime(
          requestedTimeUs,
          asset.durationUs,
          frameRateForAsset(asset),
        ),
        ...boundedFrameSize(asset.width ?? 1920, asset.height ?? 1080, quality),
      };
    }
    const sequence = sequenceFor(open.project, target.sequenceId);
    return {
      normalizedTimeUs: normalizeDerivedFrameTime(
        requestedTimeUs,
        sequenceDurationUs(sequence),
        sequence.frameRate,
      ),
      ...boundedFrameSize(sequence.width, sequence.height, quality),
    };
  }

  async #getOrRender(
    open: OpenFrameProject,
    target: FrameTarget,
    requestedTimeUs: TimeUs,
    quality: FrameQuality,
    specification: FrameSpecification,
  ): Promise<FrameArtifact> {
    const paths = await ProjectPaths.open(open.directory);
    await paths.ensureLayout(["frames"]);
    const base = derivedFrameArtifactBaseName(target, specification.normalizedTimeUs, quality);
    const path = await paths.assertSafeDerivedFile(join(".video", "frames", `${base}.png`));
    const metadataPath = await paths.assertSafeDerivedFile(
      join(".video", "frames", `${base}.json`),
    );
    const sourceFingerprint = specification.asset
      ? await this.sourceFingerprint(specification.asset.id)
      : undefined;
    const cached = await this.#cached({
      open,
      target,
      quality,
      requestedTimeUs,
      normalizedTimeUs: specification.normalizedTimeUs,
      path,
      metadataPath,
      sourceFingerprint,
    });
    if (cached) return cached;
    return this.#render({
      open,
      target,
      quality,
      requestedTimeUs,
      specification,
      path,
      metadataPath,
      sourceFingerprint,
    });
  }

  async #cached(input: {
    open: OpenFrameProject;
    target: FrameTarget;
    quality: FrameQuality;
    requestedTimeUs: TimeUs;
    normalizedTimeUs: TimeUs;
    path: string;
    metadataPath: string;
    sourceFingerprint?: SourceFingerprint | undefined;
  }): Promise<FrameArtifact | null> {
    try {
      const persisted = persistedFrameSchema.parse(
        JSON.parse(await readFile(input.metadataPath, "utf8")) as unknown,
      );
      const image = await stat(input.path);
      const fingerprintMatches = input.sourceFingerprint
        ? persisted.sourceFingerprint !== undefined &&
          projectSourceFingerprintsEqual(persisted.sourceFingerprint, input.sourceFingerprint)
        : persisted.acceptedGeneration === input.open.acceptedGeneration;
      if (
        !sameTarget(persisted.target, input.target) ||
        persisted.quality !== input.quality ||
        persisted.normalizedTimeUs !== input.normalizedTimeUs ||
        persisted.bytes !== image.size ||
        !fingerprintMatches
      )
        return null;
      return publicArtifact(persisted, { ...input, cached: true });
    } catch {
      return null;
    }
  }

  #render(input: {
    open: OpenFrameProject;
    target: FrameTarget;
    quality: FrameQuality;
    requestedTimeUs: TimeUs;
    specification: FrameSpecification;
    path: string;
    metadataPath: string;
    sourceFingerprint?: SourceFingerprint | undefined;
  }): Promise<FrameArtifact> {
    const request: FrameRenderRequest = {
      requestId: randomUUID(),
      projectScope: input.open.scope,
      target: input.target,
      quality: input.quality,
      requestedTimeUs: input.requestedTimeUs,
      normalizedTimeUs: input.specification.normalizedTimeUs,
      width: input.specification.width,
      height: input.specification.height,
      acceptedGeneration: input.open.acceptedGeneration,
    };
    return new Promise<FrameArtifact>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(request.requestId);
        if (!pending) return;
        this.cancelDispatch(request.requestId);
        this.#rejectPending(pending, new Error("Exact-frame generation timed out"));
      }, FRAME_TIMEOUT_MS);
      const redispatch = setInterval(() => {
        if (this.#pending.has(request.requestId)) this.dispatch(request);
      }, 500);
      this.#pending.set(request.requestId, {
        request,
        path: input.path,
        metadataPath: input.metadataPath,
        sourceFingerprint: input.sourceFingerprint,
        resolve,
        reject,
        timeout,
        redispatch,
      });
      if (!this.dispatch(request)) {
        const pending = this.#pending.get(request.requestId);
        if (pending)
          this.#rejectPending(pending, new Error("Frame generation requires an open renderer"));
      }
    });
  }

  #persisted(pending: PendingFrame, completion: FrameRenderCompletion): PersistedFrame {
    return persistedFrameSchema.parse({
      version: 1,
      generatorVersion: FRAME_GENERATOR_VERSION,
      target: pending.request.target,
      quality: pending.request.quality,
      normalizedTimeUs: pending.request.normalizedTimeUs,
      renderedTimeUs: completion.renderedTimeUs,
      width: completion.width,
      height: completion.height,
      bytes: completion.png.byteLength,
      ...(pending.sourceFingerprint ? { sourceFingerprint: pending.sourceFingerprint } : {}),
      ...(pending.request.target.kind === "timeline"
        ? { acceptedGeneration: pending.request.acceptedGeneration }
        : {}),
    });
  }

  #validateCompletion(pending: PendingFrame, completion: FrameRenderCompletion): void {
    if (completion.png.byteLength <= 0 || completion.png.byteLength > MAX_FRAME_BYTES)
      throw new Error("Generated frame exceeds the bounded PNG budget");
    if (completion.width !== pending.request.width || completion.height !== pending.request.height)
      throw new Error("Generated frame dimensions do not match the request");
    if (completion.renderedTimeUs < 0)
      throw new Error("Generated frame reported an invalid media timestamp");
  }

  async #publish(pending: PendingFrame, persisted: PersistedFrame, png: Uint8Array): Promise<void> {
    await mkdir(dirname(pending.path), { recursive: true });
    const suffix = randomUUID();
    const temporaryImage = `${pending.path}.${suffix}.tmp`;
    const temporaryMetadata = `${pending.metadataPath}.${suffix}.tmp`;
    try {
      await writeFile(temporaryImage, png, { flag: "wx" });
      await rename(temporaryImage, pending.path);
      await writeFile(temporaryMetadata, `${JSON.stringify(persisted, null, 2)}\n`, { flag: "wx" });
      await rename(temporaryMetadata, pending.metadataPath);
    } finally {
      await Promise.all([
        rm(temporaryImage, { force: true }).catch(() => undefined),
        rm(temporaryMetadata, { force: true }).catch(() => undefined),
      ]);
    }
  }

  #assertScope(scope: DerivedProjectScope): void {
    const open = this.#requireOpen();
    if (scope.cacheKey !== open.scope.cacheKey || scope.epoch !== open.scope.epoch)
      throw new Error("Stale exact-frame project scope");
  }

  #requireOpen(): OpenFrameProject {
    if (!this.#open) throw new Error("No project is open");
    return this.#open;
  }

  #settle(requestId: string): PendingFrame | undefined {
    const pending = this.#pending.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timeout);
    clearInterval(pending.redispatch);
    this.#pending.delete(requestId);
    return pending;
  }

  #rejectPending(pending: PendingFrame, error: Error): void {
    this.#settle(pending.request.requestId);
    pending.reject(error);
  }

  #cancelAll(detail: string): void {
    for (const pending of this.#pending.values()) {
      this.cancelDispatch(pending.request.requestId);
      this.#rejectPending(pending, new Error(detail));
    }
  }

  async #withRequestedTime(
    operation: Promise<FrameArtifact>,
    requestedTimeUs: TimeUs,
  ): Promise<FrameArtifact> {
    return { ...(await operation), requestedTimeUs };
  }
}

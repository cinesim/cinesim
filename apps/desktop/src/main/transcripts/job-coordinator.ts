import type { Asset, AssetId, Project } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import type { DerivedProjectScope, SourceFingerprint } from "../../shared/contracts";
import type {
  TranscriptArtifact,
  TranscriptAudioChunkInput,
  TranscriptGenerationOptions,
  TranscriptSnapshot,
} from "../../shared/transcript";
import { fingerprintsEqual } from "../derived-media/source-fingerprint";
import { TranscriptArtifactRepository, validTranscriptAssetId } from "./artifact-repository";
import { TranscriptChunkRepository } from "./chunk-repository";
import { TranscriptionGateway } from "./gateway";
import { emptyTranscriptIndex, TranscriptIndexRepository } from "./index-repository";
import type { PersistedTranscriptIndex } from "./index-repository";
import { stitchTranscriptChunks } from "./stitch";
import type { CompletedTranscriptChunk } from "./stitch";

const MAX_AUDIO_CHUNK_BYTES = 24 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 2;
const MAX_CHUNKS_PER_JOB = 1_000;
const MAX_CHUNK_DURATION_US = 10 * 60 * 1_000_000;
const MAX_TOTAL_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_WORDS = 500_000;
const MAX_TOTAL_UTTERANCES = 100_000;
const MAX_PCM_BYTES_PER_SECOND = 192_000;
const log = createCinesimLogger({ service: "transcripts" });

export interface TranscriptAccountGateway {
  requireCachedUser(): unknown;
  authenticatedFetch(path: string, init?: RequestInit): Promise<Response>;
}

interface ActiveTranscriptJob {
  id: string;
  abort: AbortController;
  asset: Asset;
  sourceFingerprint: SourceFingerprint;
  options: TranscriptGenerationOptions;
  state: "idle" | "chunk-in-flight" | "finalizing" | "terminal";
  nextChunkIndex: number;
  nextSourceStartUs: number;
  totalAudioBytes: number;
  totalResponseBytes: number;
  totalWords: number;
  totalUtterances: number;
  chunks: CompletedTranscriptChunk[];
}

function defaultOptions(project: Project, asset: Asset): TranscriptGenerationOptions {
  const keyterms = [...new Set([project.name.trim(), asset.name.trim()].filter(Boolean))].slice(
    0,
    100,
  );
  return {
    language: null,
    detectLanguage: true,
    multilingual: true,
    diarization: true,
    utterances: true,
    paragraphs: true,
    smartFormat: true,
    punctuation: true,
    fillerWords: true,
    profanityFilter: false,
    redactPersonalInformation: false,
    keyterms,
  };
}

function sanitizedFailureCode(value: string): string {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : "transcription-failed";
}

function jobLimits(durationUs: number) {
  const durationSeconds = Math.max(1, Math.ceil(durationUs / 1_000_000));
  return {
    chunks: Math.min(MAX_CHUNKS_PER_JOB, durationSeconds + 1),
    audioBytes: Math.min(
      MAX_TOTAL_AUDIO_BYTES,
      durationSeconds * MAX_PCM_BYTES_PER_SECOND + 64 * 1024 * Math.min(durationSeconds, 1_000),
    ),
    responseBytes: Math.min(MAX_TOTAL_RESPONSE_BYTES, durationSeconds * 64 * 1024 + 1024 * 1024),
    words: Math.min(MAX_TOTAL_WORDS, durationSeconds * 10 + 100),
    utterances: Math.min(MAX_TOTAL_UTTERANCES, durationSeconds * 2 + 100),
  };
}

export interface TranscriptCoordinatorDependencies {
  indexRepository?: Pick<TranscriptIndexRepository, "read" | "write">;
  artifactRepository?: Pick<TranscriptArtifactRepository, "read" | "write" | "remove">;
  chunkRepository?: Pick<TranscriptChunkRepository, "read" | "write" | "removeJob">;
  gateway?: Pick<TranscriptionGateway, "transcribe"> | null;
}

export class TranscriptJobCoordinator {
  readonly #listeners = new Set<(snapshot: TranscriptSnapshot) => void>();
  readonly #jobs = new Map<string, ActiveTranscriptJob>();
  readonly #indexRepository: Pick<TranscriptIndexRepository, "read" | "write">;
  readonly #artifactRepository: Pick<TranscriptArtifactRepository, "read" | "write" | "remove">;
  readonly #chunkRepository: Pick<TranscriptChunkRepository, "read" | "write" | "removeJob">;
  readonly #gateway: Pick<TranscriptionGateway, "transcribe"> | null;
  #operationQueue: Promise<void> = Promise.resolve();
  #directory: string | null = null;
  #scope: DerivedProjectScope | null = null;
  #project: Project | null = null;
  #index: PersistedTranscriptIndex = emptyTranscriptIndex();

  constructor(
    private readonly account: TranscriptAccountGateway | null,
    private readonly fingerprintForAsset: (assetId: string) => Promise<SourceFingerprint>,
    dependencies: TranscriptCoordinatorDependencies = {},
  ) {
    this.#indexRepository = dependencies.indexRepository ?? new TranscriptIndexRepository();
    this.#artifactRepository =
      dependencies.artifactRepository ?? new TranscriptArtifactRepository();
    this.#chunkRepository = dependencies.chunkRepository ?? new TranscriptChunkRepository();
    this.#gateway = dependencies.gateway ?? (account ? new TranscriptionGateway(account) : null);
  }

  async setProject(directory: string, project: Project, scope: DerivedProjectScope): Promise<void> {
    return this.#serialize(async () => {
      const jobs = [...this.#jobs.values()];
      for (const job of jobs) {
        job.state = "terminal";
        job.abort.abort();
      }
      const previousDirectory = this.#directory;
      if (previousDirectory)
        await Promise.all(
          jobs.map((job) => this.#chunkRepository.removeJob(previousDirectory, job.id)),
        );
      this.#directory = directory;
      this.#project = structuredClone(project);
      this.#scope = structuredClone(scope);
      this.#jobs.clear();
      this.#index = await this.#indexRepository.read(directory);
      const retained = new Set(project.assets.map((asset) => asset.id));
      for (const assetId of Object.keys(this.#index.assets)) {
        if (!retained.has(assetId as AssetId)) delete this.#index.assets[assetId];
      }
      await this.#persistIndex();
      this.#emit();
    });
  }

  async updateProject(project: Project): Promise<void> {
    return this.#serialize(async () => {
      this.#project = structuredClone(project);
      const retained = new Set(project.assets.map((asset) => asset.id));
      for (const assetId of Object.keys(this.#index.assets)) {
        if (retained.has(assetId as AssetId)) continue;
        delete this.#index.assets[assetId];
        if (validTranscriptAssetId(assetId)) {
          await this.#artifactRepository.remove(this.#requireDirectory(), assetId);
        }
      }
      await this.#persistIndex();
      this.#emit();
    });
  }

  async clearProject(): Promise<void> {
    return this.#serialize(async () => {
      const jobs = [...this.#jobs.values()];
      const directory = this.#directory;
      for (const job of jobs) {
        job.state = "terminal";
        job.abort.abort();
      }
      if (directory)
        await Promise.all(jobs.map((job) => this.#chunkRepository.removeJob(directory, job.id)));
      this.#directory = null;
      this.#scope = null;
      this.#project = null;
      this.#index = emptyTranscriptIndex();
      this.#jobs.clear();
    });
  }

  subscribe(listener: (snapshot: TranscriptSnapshot) => void): () => void {
    this.#listeners.add(listener);
    if (this.#directory) listener(this.#metadataSnapshot());
    return () => this.#listeners.delete(listener);
  }

  async snapshot(scope: DerivedProjectScope, artifactAssetIds: readonly string[] = []) {
    return this.#serialize(() => this.#snapshot(scope, artifactAssetIds));
  }

  async #snapshot(scope: DerivedProjectScope, artifactAssetIds: readonly string[] = []) {
    this.#assertScope(scope);
    const snapshot = this.#metadataSnapshot();
    for (const assetId of artifactAssetIds) {
      if (!validTranscriptAssetId(assetId)) throw new Error("Invalid transcript asset ID");
      const record = snapshot.assets[assetId];
      if (record?.state !== "ready") continue;
      try {
        record.artifact = await this.#readArtifact(assetId);
      } catch {
        record.state = "failed";
        record.failureCode = "artifact-invalid";
        this.#index.assets[assetId] = { state: "failed", failureCode: "artifact-invalid" };
        await this.#persistIndex();
      }
    }
    return snapshot;
  }

  async requestJobs(scope: DerivedProjectScope, assetIds: readonly string[]) {
    return this.#serialize(async () => {
      this.#assertScope(scope);
      if (!this.account || !this.#gateway) throw new Error("Transcription service is unavailable");
      this.account.requireCachedUser();
      if (assetIds.length === 0 || assetIds.length > 500) {
        throw new Error("Select between 1 and 500 assets to transcribe");
      }
      for (const assetId of new Set(assetIds)) {
        const asset = this.#requireAsset(assetId);
        if (asset.kind === "image" || (asset.kind === "video" && asset.hasAudio !== true)) continue;
        const fingerprint = await this.fingerprintForAsset(asset.id);
        if (fingerprint.size < 0) {
          this.#index.assets[asset.id] = { state: "failed", failureCode: "source-missing" };
          continue;
        }
        const current = this.#index.assets[asset.id];
        if (
          current?.state === "ready" &&
          current.sourceFingerprint &&
          fingerprintsEqual(current.sourceFingerprint, fingerprint)
        ) {
          continue;
        }
        this.#index.assets[asset.id] = { state: "queued", sourceFingerprint: fingerprint };
      }
      await this.#persistIndex();
      this.#emit();
      log.info(
        {
          operation: "jobs-requested",
          requestedAssets: assetIds.length,
          queuedAssets: Object.values(this.#index.assets).filter(
            (record) => record.state === "queued",
          ).length,
        },
        "Transcript jobs queued",
      );
      return this.#snapshot(scope);
    });
  }

  async cancelJobs(scope: DerivedProjectScope, assetIds: readonly string[]) {
    return this.#serialize(async () => {
      this.#assertScope(scope);
      if (assetIds.length === 0 || assetIds.length > 500) {
        throw new Error("Select between 1 and 500 transcript jobs to cancel");
      }
      for (const assetId of new Set(assetIds)) {
        const asset = this.#requireAsset(assetId);
        const active = [...this.#jobs.values()].find((job) => job.asset.id === asset.id);
        if (active) {
          active.state = "terminal";
          active.abort.abort();
          this.#jobs.delete(active.id);
          await this.#chunkRepository.removeJob(this.#requireDirectory(), active.id);
        }
        const current = this.#index.assets[asset.id];
        if (active || current?.state === "queued") {
          this.#index.assets[asset.id] = {
            state: "failed",
            ...(current?.sourceFingerprint ? { sourceFingerprint: current.sourceFingerprint } : {}),
            failureCode: "canceled",
          };
        }
      }
      await this.#persistIndex();
      this.#emit();
      return this.#snapshot(scope);
    });
  }

  async beginJob(scope: DerivedProjectScope, assetId: string): Promise<{ jobId: string }> {
    return this.#serialize(async () => {
      this.#assertScope(scope);
      if (!this.account || !this.#gateway) throw new Error("Transcription service is unavailable");
      this.account.requireCachedUser();
      if (this.#jobs.size >= MAX_ACTIVE_JOBS) throw new Error("Too many active transcription jobs");
      const asset = this.#requireAsset(assetId);
      const record = this.#index.assets[asset.id];
      if (record?.state !== "queued") throw new Error("Transcript job is not queued");
      const sourceFingerprint = await this.fingerprintForAsset(asset.id);
      const jobId = crypto.randomUUID();
      this.#jobs.set(jobId, {
        id: jobId,
        abort: new AbortController(),
        asset,
        sourceFingerprint,
        options: defaultOptions(this.#requireProject(), asset),
        state: "idle",
        nextChunkIndex: 0,
        nextSourceStartUs: 0,
        totalAudioBytes: 0,
        totalResponseBytes: 0,
        totalWords: 0,
        totalUtterances: 0,
        chunks: [],
      });
      // Persist queued while the in-memory job marks it running, so an interrupted app can resume.
      this.#index.assets[asset.id] = { state: "queued", sourceFingerprint };
      await this.#persistIndex();
      this.#emit();
      log.info({ operation: "job-started", jobId, assetId: asset.id }, "Transcript job started");
      return { jobId };
    });
  }

  async transcribeChunk(
    scope: DerivedProjectScope,
    input: TranscriptAudioChunkInput,
  ): Promise<void> {
    this.#assertScope(scope);
    const job = this.#requireJob(input.jobId);
    const limits = jobLimits(job.asset.durationUs);
    if (
      job.state !== "idle" ||
      input.chunkIndex !== job.nextChunkIndex ||
      input.chunkIndex >= limits.chunks ||
      !Number.isSafeInteger(input.sourceStartUs) ||
      !Number.isSafeInteger(input.sourceEndUs) ||
      input.sourceStartUs !== job.nextSourceStartUs ||
      input.sourceEndUs <= input.sourceStartUs ||
      input.sourceEndUs > job.asset.durationUs ||
      input.sourceEndUs - input.sourceStartUs > MAX_CHUNK_DURATION_US ||
      !(input.data instanceof Uint8Array) ||
      input.data.byteLength === 0 ||
      input.data.byteLength > MAX_AUDIO_CHUNK_BYTES ||
      job.totalAudioBytes + input.data.byteLength > limits.audioBytes
    ) {
      throw new Error("Invalid transcript audio chunk");
    }
    job.state = "chunk-in-flight";
    job.nextChunkIndex += 1;
    job.nextSourceStartUs = input.sourceEndUs;
    job.totalAudioBytes += input.data.byteLength;
    const startedAt = performance.now();
    try {
      const result = await this.#gateway!.transcribe({
        data: input.data,
        keyterms: job.options.keyterms,
        durationUs: input.sourceEndUs - input.sourceStartUs,
        signal: job.abort.signal,
      });
      const nextResponseBytes = job.totalResponseBytes + result.responseBytes;
      const nextWords = job.totalWords + result.transcript.words.length;
      const nextUtterances = job.totalUtterances + result.transcript.utterances.length;
      if (
        nextResponseBytes > limits.responseBytes ||
        nextWords > limits.words ||
        nextUtterances > limits.utterances
      ) {
        throw new Error("Transcript job exceeded its cumulative response limit");
      }
      if (this.#jobs.get(job.id) !== job || job.state !== "chunk-in-flight")
        throw new Error("Transcript job is no longer active");
      await this.#chunkRepository.write(
        this.#requireDirectory(),
        job.id,
        input.chunkIndex,
        result.transcript,
      );
      if (this.#jobs.get(job.id) !== job || job.state !== "chunk-in-flight") {
        await this.#chunkRepository.removeJob(this.#requireDirectory(), job.id);
        throw new Error("Transcript job is no longer active");
      }
      job.chunks.push({
        chunkIndex: input.chunkIndex,
        sourceStartUs: input.sourceStartUs,
        sourceEndUs: input.sourceEndUs,
        responseBytes: result.responseBytes,
        words: result.transcript.words.length,
        utterances: result.transcript.utterances.length,
      });
      job.totalResponseBytes = nextResponseBytes;
      job.totalWords = nextWords;
      job.totalUtterances = nextUtterances;
      job.state = "idle";
      log.info(
        {
          operation: "chunk-completed",
          jobId: job.id,
          assetId: job.asset.id,
          chunkIndex: input.chunkIndex,
          audioBytes: input.data.byteLength,
          sourceStartUs: input.sourceStartUs,
          sourceEndUs: input.sourceEndUs,
          sourceDurationUs: input.sourceEndUs - input.sourceStartUs,
          providerAudioDurationSeconds: result.transcript.durationSeconds,
          lastWordEndSeconds: result.transcript.words.at(-1)?.endSeconds ?? null,
          durationMs: performance.now() - startedAt,
          requestId: result.transcript.requestId,
          words: result.transcript.words.length,
          utterances: result.transcript.utterances.length,
        },
        "Transcript chunk completed",
      );
    } catch (error) {
      if (this.#jobs.get(job.id) === job && job.state === "chunk-in-flight") {
        job.state = "idle";
        job.nextChunkIndex -= 1;
        job.nextSourceStartUs = input.sourceStartUs;
        job.totalAudioBytes -= input.data.byteLength;
      }
      log.error(
        {
          err: error,
          operation: "chunk-failed",
          jobId: job.id,
          assetId: job.asset.id,
          chunkIndex: input.chunkIndex,
          audioBytes: input.data.byteLength,
          durationMs: performance.now() - startedAt,
        },
        "Transcript chunk failed",
      );
      throw error;
    }
  }

  async finalizeJob(scope: DerivedProjectScope, jobId: string): Promise<TranscriptSnapshot> {
    return this.#serialize(async () => {
      this.#assertScope(scope);
      const job = this.#requireJob(jobId);
      if (job.state !== "idle") throw new Error("Transcript job is busy");
      if (job.chunks.length === 0) throw new Error("Transcript job has no completed audio chunks");
      if (job.nextSourceStartUs !== job.asset.durationUs)
        throw new Error("Transcript chunks do not cover the complete asset");
      job.state = "finalizing";
      const directory = this.#requireDirectory();
      try {
        const artifact = await stitchTranscriptChunks({
          asset: job.asset,
          sourceFingerprint: job.sourceFingerprint,
          options: job.options,
          chunks: job.chunks,
          readChunk: (chunkIndex) => this.#chunkRepository.read(directory, job.id, chunkIndex),
        });
        if (this.#jobs.get(job.id) !== job || job.state !== "finalizing")
          throw new Error("Transcript job is no longer active");
        await this.#artifactRepository.write(directory, artifact, job.id);
        job.state = "terminal";
        this.#jobs.delete(job.id);
        await this.#chunkRepository.removeJob(directory, job.id);
        this.#index.assets[job.asset.id] = {
          state: "ready",
          sourceFingerprint: job.sourceFingerprint,
        };
        await this.#persistIndex();
        this.#emit();
        log.info(
          {
            operation: "job-completed",
            jobId: job.id,
            assetId: job.asset.id,
            chunks: job.chunks.length,
            words: artifact.words.length,
            utterances: artifact.utterances.length,
          },
          "Transcript artifact completed",
        );
        return this.#snapshot(scope, [job.asset.id]);
      } catch (error) {
        if (this.#jobs.get(job.id) === job && job.state === "finalizing") job.state = "idle";
        throw error;
      }
    });
  }

  async failJob(
    scope: DerivedProjectScope,
    jobId: string,
    failureCode: string,
    detail?: string,
  ): Promise<TranscriptSnapshot> {
    return this.#serialize(async () => {
      this.#assertScope(scope);
      const job = this.#requireJob(jobId);
      job.state = "terminal";
      job.abort.abort();
      this.#jobs.delete(job.id);
      await this.#chunkRepository.removeJob(this.#requireDirectory(), job.id);
      this.#index.assets[job.asset.id] = {
        state: "failed",
        sourceFingerprint: job.sourceFingerprint,
        failureCode: sanitizedFailureCode(failureCode),
      };
      await this.#persistIndex();
      this.#emit();
      log.error(
        {
          operation: "job-failed",
          jobId: job.id,
          assetId: job.asset.id,
          failureCode: sanitizedFailureCode(failureCode),
          ...(detail ? { detail: detail.slice(0, 2_000) } : {}),
        },
        "Transcript job failed",
      );
      return this.#snapshot(scope);
    });
  }

  async #readArtifact(assetId: AssetId): Promise<TranscriptArtifact> {
    const artifact = await this.#artifactRepository.read(this.#requireDirectory(), assetId);
    const record = this.#index.assets[assetId];
    if (
      record?.sourceFingerprint &&
      !fingerprintsEqual(record.sourceFingerprint, artifact.sourceFingerprint)
    ) {
      throw new Error("Transcript artifact fingerprint mismatch");
    }
    return artifact;
  }

  async #persistIndex(): Promise<void> {
    await this.#indexRepository.write(this.#requireDirectory(), this.#index);
  }

  #metadataSnapshot(): TranscriptSnapshot {
    const assets: TranscriptSnapshot["assets"] = {};
    for (const asset of this.#requireProject().assets) {
      if (asset.kind === "image" || (asset.kind === "video" && asset.hasAudio !== true)) continue;
      const record = this.#index.assets[asset.id];
      assets[asset.id] = {
        assetId: asset.id,
        state: this.#jobsHasAsset(asset.id) ? "running" : (record?.state ?? "missing"),
        ...(record?.failureCode ? { failureCode: record.failureCode } : {}),
      };
    }
    return {
      projectDirectory: this.#requireDirectory(),
      projectScope: structuredClone(this.#requireScope()),
      assets,
    };
  }

  #jobsHasAsset(assetId: AssetId): boolean {
    return [...this.#jobs.values()].some((job) => job.asset.id === assetId);
  }

  #emit(): void {
    if (!this.#directory) return;
    const snapshot = this.#metadataSnapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #assertScope(scope: DerivedProjectScope): void {
    const current = this.#requireScope();
    if (scope.cacheKey !== current.cacheKey || scope.epoch !== current.epoch) {
      throw new Error("Stale transcript project scope");
    }
  }

  #requireAsset(assetId: string): Asset {
    if (!validTranscriptAssetId(assetId)) throw new Error("Invalid transcript asset ID");
    const asset = this.#requireProject().assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error("Unknown transcript asset");
    return asset;
  }

  #requireJob(jobId: string): ActiveTranscriptJob {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error("Invalid transcript job ID");
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error("Unknown transcript job");
    return job;
  }

  #requireDirectory(): string {
    if (!this.#directory) throw new Error("No transcript project is open");
    return this.#directory;
  }

  #requireScope(): DerivedProjectScope {
    if (!this.#scope) throw new Error("No transcript project scope is active");
    return this.#scope;
  }

  #requireProject(): Project {
    if (!this.#project) throw new Error("No transcript project is open");
    return this.#project;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.catch(() => undefined).then(operation);
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

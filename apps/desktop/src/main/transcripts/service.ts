import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, AssetId, Project } from "@cinesim/core";
import { stableJson } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { z } from "zod";
import type { DerivedProjectScope, SourceFingerprint } from "../../shared/api";
import {
  TRANSCRIPT_ARTIFACT_VERSION,
  TRANSCRIPT_GENERATOR_VERSION,
  TRANSCRIPTION_MODEL,
} from "../../shared/transcript";
import type {
  TranscriptArtifact,
  TranscriptArtifactUtterance,
  TranscriptArtifactWord,
  TranscriptAudioChunkInput,
  TranscriptGenerationOptions,
  TranscriptSnapshot,
} from "../../shared/transcript";
import { fingerprintsEqual } from "../derived-media/source-fingerprint";
import { parseTranscriptArtifact } from "./artifact";

const INDEX_PATH = join(".video", "transcripts", "index.json");
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 24 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 2;
const log = createCinesimLogger({ service: "transcripts" });

interface AccountGateway {
  requireCachedUser(): unknown;
  authenticatedFetch(path: string, init?: RequestInit): Promise<Response>;
}

interface PersistedTranscriptRecord {
  state: "missing" | "queued" | "ready" | "failed";
  sourceFingerprint?: SourceFingerprint;
  failureCode?: string;
}

interface PersistedTranscriptIndex {
  version: 1;
  generatorVersion: typeof TRANSCRIPT_GENERATOR_VERSION;
  assets: Record<string, PersistedTranscriptRecord>;
}

interface GatewayTranscript {
  requestId: string | null;
  model: typeof TRANSCRIPTION_MODEL;
  text: string;
  language: string | null;
  durationSeconds: number | null;
  confidence?: number;
  words: Array<{
    text: string;
    startSeconds: number;
    endSeconds: number;
    confidence?: number;
    speaker?: string;
    utteranceId?: string;
    paragraphId?: string;
    detectedLanguage?: string;
  }>;
  utterances: Array<{
    id: string;
    startSeconds: number;
    endSeconds: number;
    speaker?: string;
    confidence?: number;
    detectedLanguage?: string;
    wordIndexes: number[];
  }>;
}

interface CompletedChunk {
  chunkIndex: number;
  sourceStartUs: number;
  sourceEndUs: number;
  transcript: GatewayTranscript;
}

interface ActiveTranscriptJob {
  id: string;
  abort: AbortController;
  asset: Asset;
  sourceFingerprint: SourceFingerprint;
  options: TranscriptGenerationOptions;
  nextChunkIndex: number;
  chunks: CompletedChunk[];
}

const gatewayTranscriptSchema = z.object({
  requestId: z.string().nullable(),
  model: z.literal(TRANSCRIPTION_MODEL),
  text: z.string(),
  language: z.string().nullable(),
  durationSeconds: z.number().nonnegative().finite().nullable(),
  confidence: z.number().min(0).max(1).optional(),
  words: z.array(
    z
      .object({
        text: z.string().min(1).max(1_000),
        startSeconds: z.number().nonnegative().finite(),
        endSeconds: z.number().nonnegative().finite(),
        confidence: z.number().min(0).max(1).optional(),
        speaker: z.string().min(1).max(128).optional(),
        utteranceId: z.string().min(1).max(128).optional(),
        paragraphId: z.string().min(1).max(128).optional(),
        detectedLanguage: z.string().min(1).max(32).optional(),
      })
      .refine((word) => word.endSeconds > word.startSeconds),
  ),
  utterances: z.array(
    z
      .object({
        id: z.string().min(1).max(128),
        startSeconds: z.number().nonnegative().finite(),
        endSeconds: z.number().nonnegative().finite(),
        speaker: z.string().min(1).max(128).optional(),
        confidence: z.number().min(0).max(1).optional(),
        detectedLanguage: z.string().min(1).max(32).optional(),
        wordIndexes: z.array(z.number().int().nonnegative().safe()).max(100_000),
      })
      .refine((utterance) => utterance.endSeconds > utterance.startSeconds),
  ),
});

function emptyIndex(): PersistedTranscriptIndex {
  return { version: 1, generatorVersion: TRANSCRIPT_GENERATOR_VERSION, assets: {} };
}

function validAssetId(value: string): value is AssetId {
  return /^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
}

function artifactRelativePath(assetId: AssetId): string {
  if (!validAssetId(assetId)) throw new Error("Invalid transcript asset ID");
  return join(".video", "transcripts", `${assetId}.json`);
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

export class TranscriptStore {
  readonly #listeners = new Set<(snapshot: TranscriptSnapshot) => void>();
  readonly #jobs = new Map<string, ActiveTranscriptJob>();
  #directory: string | null = null;
  #scope: DerivedProjectScope | null = null;
  #project: Project | null = null;
  #index: PersistedTranscriptIndex = emptyIndex();

  constructor(
    private readonly account: AccountGateway | null,
    private readonly fingerprintForAsset: (assetId: string) => Promise<SourceFingerprint>,
  ) {}

  async setProject(directory: string, project: Project, scope: DerivedProjectScope): Promise<void> {
    for (const job of this.#jobs.values()) job.abort.abort();
    this.#directory = directory;
    this.#project = structuredClone(project);
    this.#scope = structuredClone(scope);
    this.#jobs.clear();
    this.#index = await this.#readIndex(directory);
    const retained = new Set(project.assets.map((asset) => asset.id));
    for (const assetId of Object.keys(this.#index.assets)) {
      if (!retained.has(assetId as AssetId)) delete this.#index.assets[assetId];
    }
    await this.#persistIndex();
    this.#emit();
  }

  async updateProject(project: Project): Promise<void> {
    this.#project = structuredClone(project);
    const retained = new Set(project.assets.map((asset) => asset.id));
    for (const assetId of Object.keys(this.#index.assets)) {
      if (retained.has(assetId as AssetId)) continue;
      delete this.#index.assets[assetId];
      if (validAssetId(assetId)) {
        await rm(join(this.#requireDirectory(), artifactRelativePath(assetId)), { force: true });
      }
    }
    await this.#persistIndex();
    this.#emit();
  }

  async clearProject(): Promise<void> {
    for (const job of this.#jobs.values()) job.abort.abort();
    this.#directory = null;
    this.#scope = null;
    this.#project = null;
    this.#index = emptyIndex();
    this.#jobs.clear();
  }

  subscribe(listener: (snapshot: TranscriptSnapshot) => void): () => void {
    this.#listeners.add(listener);
    if (this.#directory) listener(this.#metadataSnapshot());
    return () => this.#listeners.delete(listener);
  }

  async snapshot(scope: DerivedProjectScope, artifactAssetIds: readonly string[] = []) {
    this.#assertScope(scope);
    const snapshot = this.#metadataSnapshot();
    for (const assetId of artifactAssetIds) {
      if (!validAssetId(assetId)) throw new Error("Invalid transcript asset ID");
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
    this.#assertScope(scope);
    if (!this.account) throw new Error("Transcription service is unavailable");
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
    return this.snapshot(scope);
  }

  async cancelJobs(scope: DerivedProjectScope, assetIds: readonly string[]) {
    this.#assertScope(scope);
    if (assetIds.length === 0 || assetIds.length > 500) {
      throw new Error("Select between 1 and 500 transcript jobs to cancel");
    }
    for (const assetId of new Set(assetIds)) {
      const asset = this.#requireAsset(assetId);
      const active = [...this.#jobs.values()].find((job) => job.asset.id === asset.id);
      active?.abort.abort();
      if (active) this.#jobs.delete(active.id);
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
    return this.snapshot(scope);
  }

  async beginJob(scope: DerivedProjectScope, assetId: string): Promise<{ jobId: string }> {
    this.#assertScope(scope);
    if (!this.account) throw new Error("Transcription service is unavailable");
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
      nextChunkIndex: 0,
      chunks: [],
    });
    // Persist queued while the in-memory job marks it running, so an interrupted app can resume.
    this.#index.assets[asset.id] = { state: "queued", sourceFingerprint };
    await this.#persistIndex();
    this.#emit();
    log.info({ operation: "job-started", jobId, assetId: asset.id }, "Transcript job started");
    return { jobId };
  }

  async transcribeChunk(
    scope: DerivedProjectScope,
    input: TranscriptAudioChunkInput,
  ): Promise<void> {
    this.#assertScope(scope);
    const job = this.#requireJob(input.jobId);
    if (
      input.chunkIndex !== job.nextChunkIndex ||
      !Number.isSafeInteger(input.sourceStartUs) ||
      !Number.isSafeInteger(input.sourceEndUs) ||
      input.sourceStartUs < 0 ||
      input.sourceEndUs <= input.sourceStartUs ||
      input.sourceEndUs > job.asset.durationUs ||
      !(input.data instanceof Uint8Array) ||
      input.data.byteLength === 0 ||
      input.data.byteLength > MAX_AUDIO_CHUNK_BYTES
    ) {
      throw new Error("Invalid transcript audio chunk");
    }
    const startedAt = performance.now();
    try {
      const response = await this.account!.authenticatedFetch("/api/v1/transcriptions?format=wav", {
        method: "POST",
        headers: {
          "content-type": "audio/wav",
          "x-cinesim-keyterms": JSON.stringify(job.options.keyterms),
        },
        body: Uint8Array.from(input.data).buffer,
        signal: AbortSignal.any([AbortSignal.timeout(90_000), job.abort.signal]),
      });
      const transcript = gatewayTranscriptSchema.parse(await response.json()) as GatewayTranscript;
      job.chunks.push({
        chunkIndex: input.chunkIndex,
        sourceStartUs: input.sourceStartUs,
        sourceEndUs: input.sourceEndUs,
        transcript,
      });
      job.nextChunkIndex += 1;
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
          providerAudioDurationSeconds: transcript.durationSeconds,
          lastWordEndSeconds: transcript.words.at(-1)?.endSeconds ?? null,
          durationMs: performance.now() - startedAt,
          requestId: transcript.requestId,
          words: transcript.words.length,
          utterances: transcript.utterances.length,
        },
        "Transcript chunk completed",
      );
    } catch (error) {
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
    this.#assertScope(scope);
    const job = this.#requireJob(jobId);
    if (job.chunks.length === 0) throw new Error("Transcript job has no completed audio chunks");
    const artifact = this.#stitch(job);
    const path = join(this.#requireDirectory(), artifactRelativePath(job.asset.id));
    const temporaryPath = `${path}.${job.id}.tmp`;
    await writeFile(temporaryPath, stableJson(artifact), "utf8");
    await rename(temporaryPath, path);
    this.#jobs.delete(job.id);
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
    return this.snapshot(scope, [job.asset.id]);
  }

  async failJob(
    scope: DerivedProjectScope,
    jobId: string,
    failureCode: string,
    detail?: string,
  ): Promise<TranscriptSnapshot> {
    this.#assertScope(scope);
    const job = this.#requireJob(jobId);
    this.#jobs.delete(job.id);
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
    return this.snapshot(scope);
  }

  #stitch(job: ActiveTranscriptJob): TranscriptArtifact {
    const words: TranscriptArtifactWord[] = [];
    const utterances: TranscriptArtifactUtterance[] = [];
    const requestIds = new Set<string>();
    let language: string | null = null;
    let confidenceTotal = 0;
    let confidenceCount = 0;
    for (const chunk of job.chunks.toSorted((left, right) => left.chunkIndex - right.chunkIndex)) {
      if (chunk.transcript.requestId) requestIds.add(chunk.transcript.requestId);
      language ??= chunk.transcript.language;
      const localWordIds: string[] = [];
      const localUtteranceIds = new Map<number, string>();
      for (const utterance of chunk.transcript.utterances) {
        const utteranceId = `utterance_${String(utterances.length + 1).padStart(6, "0")}`;
        for (const wordIndex of utterance.wordIndexes)
          localUtteranceIds.set(wordIndex, utteranceId);
        const sourceStartUs = Math.max(
          chunk.sourceStartUs,
          chunk.sourceStartUs + Math.round(utterance.startSeconds * 1_000_000),
        );
        const sourceEndUs = Math.min(
          chunk.sourceEndUs,
          chunk.sourceStartUs + Math.round(utterance.endSeconds * 1_000_000),
        );
        if (sourceEndUs <= sourceStartUs) continue;
        utterances.push({
          id: utteranceId,
          sourceStartUs,
          sourceEndUs,
          ...(utterance.speaker ? { speakerClusterId: `speaker-${utterance.speaker}` } : {}),
          ...(utterance.confidence === undefined ? {} : { confidence: utterance.confidence }),
          ...(utterance.detectedLanguage ? { detectedLanguage: utterance.detectedLanguage } : {}),
          wordIds: [],
        });
      }
      for (let index = 0; index < chunk.transcript.words.length; index += 1) {
        const providerWord = chunk.transcript.words[index]!;
        const sourceStartUs = Math.max(
          chunk.sourceStartUs,
          chunk.sourceStartUs + Math.round(providerWord.startSeconds * 1_000_000),
        );
        const sourceEndUs = Math.min(
          chunk.sourceEndUs,
          chunk.sourceStartUs + Math.round(providerWord.endSeconds * 1_000_000),
        );
        if (sourceEndUs <= sourceStartUs) continue;
        const id = `word_${String(words.length + 1).padStart(6, "0")}`;
        const utteranceId = localUtteranceIds.get(index);
        words.push({
          id,
          text: providerWord.text,
          sourceStartUs,
          sourceEndUs,
          ...(providerWord.confidence === undefined ? {} : { confidence: providerWord.confidence }),
          ...(providerWord.speaker ? { speakerClusterId: `speaker-${providerWord.speaker}` } : {}),
          ...(utteranceId ? { utteranceId } : {}),
          ...(providerWord.paragraphId ? { paragraphId: providerWord.paragraphId } : {}),
          ...(providerWord.detectedLanguage
            ? { detectedLanguage: providerWord.detectedLanguage }
            : {}),
        });
        localWordIds[index] = id;
        if (providerWord.confidence !== undefined) {
          confidenceTotal += providerWord.confidence;
          confidenceCount += 1;
        }
      }
      for (const utterance of chunk.transcript.utterances) {
        const utteranceId = localUtteranceIds.get(utterance.wordIndexes[0] ?? -1);
        const output = utterances.find((candidate) => candidate.id === utteranceId);
        if (output)
          output.wordIds = utterance.wordIndexes.flatMap((index) => localWordIds[index] ?? []);
      }
    }
    const requestId = requestIds.size > 0 ? [...requestIds].sort().join(",") : undefined;
    return parseTranscriptArtifact({
      version: TRANSCRIPT_ARTIFACT_VERSION,
      assetId: job.asset.id,
      sourceFingerprint: job.sourceFingerprint,
      generator: {
        gateway: "direct",
        provider: "deepgram",
        model: TRANSCRIPTION_MODEL,
        version: TRANSCRIPT_GENERATOR_VERSION,
        ...(requestId ? { requestId } : {}),
      },
      options: job.options,
      language,
      durationUs: job.asset.durationUs,
      ...(confidenceCount > 0 ? { confidence: confidenceTotal / confidenceCount } : {}),
      words,
      utterances: utterances.filter((utterance) => utterance.wordIds.length > 0),
    });
  }

  async #readIndex(directory: string): Promise<PersistedTranscriptIndex> {
    try {
      const value = JSON.parse(await readFile(join(directory, INDEX_PATH), "utf8")) as unknown;
      const input = value as Partial<PersistedTranscriptIndex>;
      if (
        input.version !== 1 ||
        input.generatorVersion !== TRANSCRIPT_GENERATOR_VERSION ||
        !input.assets ||
        typeof input.assets !== "object"
      ) {
        return emptyIndex();
      }
      const index = structuredClone(input) as PersistedTranscriptIndex;
      for (const [assetId, record] of Object.entries(index.assets)) {
        if (
          !validAssetId(assetId) ||
          !["missing", "queued", "ready", "failed"].includes(record.state)
        ) {
          delete index.assets[assetId];
        }
      }
      return index;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
      return emptyIndex();
    }
  }

  async #readArtifact(assetId: AssetId): Promise<TranscriptArtifact> {
    const path = join(this.#requireDirectory(), artifactRelativePath(assetId));
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Transcript artifact is outside its size bound");
    }
    const artifact = parseTranscriptArtifact(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (artifact.assetId !== assetId) throw new Error("Transcript artifact asset mismatch");
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
    const path = join(this.#requireDirectory(), INDEX_PATH);
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, stableJson(this.#index), "utf8");
    await rename(temporaryPath, path);
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
    if (!validAssetId(assetId)) throw new Error("Invalid transcript asset ID");
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
}

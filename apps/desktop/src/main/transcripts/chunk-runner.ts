import type { Asset } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import type { SourceFingerprint } from "../../shared/contracts";
import type {
  TranscriptAudioChunkInput,
  TranscriptGenerationOptions,
} from "../../shared/transcript";
import type { TranscriptChunkRepository } from "./chunk-repository";
import type { TranscriptionGateway, TranscriptionGatewayResult } from "./gateway";
import type { CompletedTranscriptChunk } from "./stitch";

const MAX_AUDIO_CHUNK_BYTES = 24 * 1024 * 1024;
const MAX_CHUNKS_PER_JOB = 1_000;
const MAX_CHUNK_DURATION_US = 10 * 60 * 1_000_000;
const MAX_TOTAL_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_WORDS = 500_000;
const MAX_TOTAL_UTTERANCES = 100_000;
const MAX_PCM_BYTES_PER_SECOND = 192_000;
const log = createCinesimLogger({ service: "transcripts" });

export interface ActiveTranscriptJob {
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

type TranscriptJobLimits = ReturnType<typeof jobLimits>;

function validChunkInput(
  job: ActiveTranscriptJob,
  input: TranscriptAudioChunkInput,
  limits: TranscriptJobLimits,
): boolean {
  const expectedChunk = input.chunkIndex === job.nextChunkIndex && input.chunkIndex < limits.chunks;
  const validRange =
    Number.isSafeInteger(input.sourceStartUs) &&
    Number.isSafeInteger(input.sourceEndUs) &&
    input.sourceStartUs === job.nextSourceStartUs &&
    input.sourceEndUs > input.sourceStartUs &&
    input.sourceEndUs <= job.asset.durationUs &&
    input.sourceEndUs - input.sourceStartUs <= MAX_CHUNK_DURATION_US;
  const validData =
    input.data instanceof Uint8Array &&
    input.data.byteLength > 0 &&
    input.data.byteLength <= MAX_AUDIO_CHUNK_BYTES &&
    job.totalAudioBytes + input.data.byteLength <= limits.audioBytes;
  return job.state === "idle" && expectedChunk && validRange && validData;
}

function responseWithinLimits(
  job: ActiveTranscriptJob,
  result: TranscriptionGatewayResult,
  limits: TranscriptJobLimits,
): boolean {
  return (
    job.totalResponseBytes + result.responseBytes <= limits.responseBytes &&
    job.totalWords + result.transcript.words.length <= limits.words &&
    job.totalUtterances + result.transcript.utterances.length <= limits.utterances
  );
}

export class TranscriptChunkRunner {
  constructor(
    private readonly repository: Pick<TranscriptChunkRepository, "write" | "removeJob">,
    private readonly directory: () => string,
    private readonly isActive: (job: ActiveTranscriptJob) => boolean,
  ) {}

  async run(
    job: ActiveTranscriptJob,
    input: TranscriptAudioChunkInput,
    gateway: Pick<TranscriptionGateway, "transcribe">,
  ): Promise<void> {
    const limits = jobLimits(job.asset.durationUs);
    if (!validChunkInput(job, input, limits)) throw new Error("Invalid transcript audio chunk");
    this.#start(job, input);
    const startedAt = performance.now();
    try {
      const result = await gateway.transcribe({
        data: input.data,
        keyterms: job.options.keyterms,
        durationUs: input.sourceEndUs - input.sourceStartUs,
        signal: job.abort.signal,
      });
      if (!responseWithinLimits(job, result, limits))
        throw new Error("Transcript job exceeded its cumulative response limit");
      await this.#complete(job, input, result);
      this.#logCompleted(job, input, result, startedAt);
    } catch (error) {
      this.#rollback(job, input);
      this.#logFailed(job, input, error, startedAt);
      throw error;
    }
  }

  #start(job: ActiveTranscriptJob, input: TranscriptAudioChunkInput): void {
    job.state = "chunk-in-flight";
    job.nextChunkIndex += 1;
    job.nextSourceStartUs = input.sourceEndUs;
    job.totalAudioBytes += input.data.byteLength;
  }

  async #complete(
    job: ActiveTranscriptJob,
    input: TranscriptAudioChunkInput,
    result: TranscriptionGatewayResult,
  ): Promise<void> {
    this.#assertActive(job);
    const directory = this.directory();
    await this.repository.write(directory, job.id, input.chunkIndex, result.transcript);
    if (!this.#isActiveChunk(job)) {
      await this.repository.removeJob(directory, job.id);
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
    job.totalResponseBytes += result.responseBytes;
    job.totalWords += result.transcript.words.length;
    job.totalUtterances += result.transcript.utterances.length;
    job.state = "idle";
  }

  #isActiveChunk(job: ActiveTranscriptJob): boolean {
    return this.isActive(job) && job.state === "chunk-in-flight";
  }

  #assertActive(job: ActiveTranscriptJob): void {
    if (!this.#isActiveChunk(job)) throw new Error("Transcript job is no longer active");
  }

  #rollback(job: ActiveTranscriptJob, input: TranscriptAudioChunkInput): void {
    if (!this.#isActiveChunk(job)) return;
    job.state = "idle";
    job.nextChunkIndex -= 1;
    job.nextSourceStartUs = input.sourceStartUs;
    job.totalAudioBytes -= input.data.byteLength;
  }

  #logCompleted(
    job: ActiveTranscriptJob,
    input: TranscriptAudioChunkInput,
    result: TranscriptionGatewayResult,
    startedAt: number,
  ): void {
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
  }

  #logFailed(
    job: ActiveTranscriptJob,
    input: TranscriptAudioChunkInput,
    error: unknown,
    startedAt: number,
  ): void {
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
  }
}

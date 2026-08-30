import type { Asset, TimeUs } from "@cinesim/core";
import { secondsToTimeUs, timeSeconds, timeUs } from "@cinesim/core";
import type { SourceFingerprint } from "../../shared/contracts";
import {
  TRANSCRIPT_ARTIFACT_VERSION,
  TRANSCRIPT_GENERATOR_VERSION,
  TRANSCRIPTION_MODEL,
} from "../../shared/transcript";
import type {
  TranscriptArtifact,
  TranscriptArtifactUtterance,
  TranscriptArtifactWord,
  TranscriptGenerationOptions,
} from "../../shared/transcript";
import { parseTranscriptArtifact } from "./artifact";
import type { StoredGatewayTranscript } from "./gateway";

export interface CompletedTranscriptChunk {
  chunkIndex: number;
  sourceStartUs: number;
  sourceEndUs: number;
  responseBytes: number;
  words: number;
  utterances: number;
}

interface StitchTranscriptInput {
  asset: Asset;
  sourceFingerprint: SourceFingerprint;
  options: TranscriptGenerationOptions;
  chunks: readonly CompletedTranscriptChunk[];
  readChunk(chunkIndex: number): Promise<StoredGatewayTranscript>;
}

interface StitchState {
  words: TranscriptArtifactWord[];
  utterances: TranscriptArtifactUtterance[];
  requestIds: Set<string>;
  language: string | null;
  confidenceTotal: number;
  confidenceCount: number;
}

interface ChunkWordIndex {
  wordIds: string[];
  utteranceIds: Map<number, string>;
}

interface SourceRange {
  sourceStartUs: TimeUs;
  sourceEndUs: TimeUs;
}

type GatewayWord = StoredGatewayTranscript["words"][number];
type GatewayUtterance = StoredGatewayTranscript["utterances"][number];

function createStitchState(): StitchState {
  return {
    words: [],
    utterances: [],
    requestIds: new Set(),
    language: null,
    confidenceTotal: 0,
    confidenceCount: 0,
  };
}

function createChunkWordIndex(): ChunkWordIndex {
  return { wordIds: [], utteranceIds: new Map() };
}

function sequenceId(kind: "utterance" | "word", index: number): string {
  return `${kind}_${String(index + 1).padStart(6, "0")}`;
}

function sourceRange(
  chunk: CompletedTranscriptChunk,
  startSeconds: number,
  endSeconds: number,
): SourceRange | null {
  const sourceStartUs = timeUs(
    Math.max(chunk.sourceStartUs, chunk.sourceStartUs + secondsToTimeUs(timeSeconds(startSeconds))),
  );
  const sourceEndUs = timeUs(
    Math.min(chunk.sourceEndUs, chunk.sourceStartUs + secondsToTimeUs(timeSeconds(endSeconds))),
  );

  return sourceEndUs > sourceStartUs ? { sourceStartUs, sourceEndUs } : null;
}

function recordTranscriptMetadata(state: StitchState, transcript: StoredGatewayTranscript): void {
  if (transcript.requestId) state.requestIds.add(transcript.requestId);
  state.language ??= transcript.language;
}

function appendUtterance(
  state: StitchState,
  localIndex: ChunkWordIndex,
  chunk: CompletedTranscriptChunk,
  utterance: GatewayUtterance,
): void {
  const id = sequenceId("utterance", state.utterances.length);
  for (const wordIndex of utterance.wordIndexes) localIndex.utteranceIds.set(wordIndex, id);

  const range = sourceRange(chunk, utterance.startSeconds, utterance.endSeconds);
  if (!range) return;

  state.utterances.push({
    id,
    ...range,
    ...(utterance.speaker ? { speakerClusterId: `speaker-${utterance.speaker}` } : {}),
    ...(utterance.confidence === undefined ? {} : { confidence: utterance.confidence }),
    ...(utterance.detectedLanguage ? { detectedLanguage: utterance.detectedLanguage } : {}),
    wordIds: [],
  });
}

function appendUtterances(
  state: StitchState,
  localIndex: ChunkWordIndex,
  chunk: CompletedTranscriptChunk,
  transcript: StoredGatewayTranscript,
): void {
  for (const utterance of transcript.utterances) {
    appendUtterance(state, localIndex, chunk, utterance);
  }
}

function recordWordConfidence(state: StitchState, confidence: number | undefined): void {
  if (confidence === undefined) return;
  state.confidenceTotal += confidence;
  state.confidenceCount += 1;
}

function appendWord(
  state: StitchState,
  localIndex: ChunkWordIndex,
  chunk: CompletedTranscriptChunk,
  providerWord: GatewayWord,
  wordIndex: number,
): void {
  const range = sourceRange(chunk, providerWord.startSeconds, providerWord.endSeconds);
  if (!range) return;

  const id = sequenceId("word", state.words.length);
  const utteranceId = localIndex.utteranceIds.get(wordIndex);
  state.words.push({
    id,
    text: providerWord.text,
    ...range,
    ...(providerWord.confidence === undefined ? {} : { confidence: providerWord.confidence }),
    ...(providerWord.speaker ? { speakerClusterId: `speaker-${providerWord.speaker}` } : {}),
    ...(utteranceId ? { utteranceId } : {}),
    ...(providerWord.paragraphId ? { paragraphId: providerWord.paragraphId } : {}),
    ...(providerWord.detectedLanguage ? { detectedLanguage: providerWord.detectedLanguage } : {}),
  });
  localIndex.wordIds[wordIndex] = id;
  recordWordConfidence(state, providerWord.confidence);
}

function appendWords(
  state: StitchState,
  localIndex: ChunkWordIndex,
  chunk: CompletedTranscriptChunk,
  transcript: StoredGatewayTranscript,
): void {
  for (let index = 0; index < transcript.words.length; index += 1) {
    appendWord(state, localIndex, chunk, transcript.words[index]!, index);
  }
}

function connectUtteranceWords(
  state: StitchState,
  localIndex: ChunkWordIndex,
  transcript: StoredGatewayTranscript,
): void {
  for (const utterance of transcript.utterances) {
    const utteranceId = localIndex.utteranceIds.get(utterance.wordIndexes[0] ?? -1);
    const output = state.utterances.find((candidate) => candidate.id === utteranceId);
    if (output) {
      output.wordIds = utterance.wordIndexes.flatMap((index) => localIndex.wordIds[index] ?? []);
    }
  }
}

function stitchChunk(
  state: StitchState,
  chunk: CompletedTranscriptChunk,
  transcript: StoredGatewayTranscript,
): void {
  const localIndex = createChunkWordIndex();
  recordTranscriptMetadata(state, transcript);
  appendUtterances(state, localIndex, chunk, transcript);
  appendWords(state, localIndex, chunk, transcript);
  connectUtteranceWords(state, localIndex, transcript);
}

function buildTranscriptArtifact(
  input: StitchTranscriptInput,
  state: StitchState,
): TranscriptArtifact {
  const requestId = state.requestIds.size > 0 ? [...state.requestIds].sort().join(",") : undefined;
  return parseTranscriptArtifact({
    version: TRANSCRIPT_ARTIFACT_VERSION,
    assetId: input.asset.id,
    sourceFingerprint: input.sourceFingerprint,
    generator: {
      gateway: "direct",
      provider: "deepgram",
      model: TRANSCRIPTION_MODEL,
      version: TRANSCRIPT_GENERATOR_VERSION,
      ...(requestId ? { requestId } : {}),
    },
    options: input.options,
    language: state.language,
    durationUs: input.asset.durationUs,
    ...(state.confidenceCount > 0
      ? { confidence: state.confidenceTotal / state.confidenceCount }
      : {}),
    words: state.words,
    utterances: state.utterances.filter((utterance) => utterance.wordIds.length > 0),
  });
}

export async function stitchTranscriptChunks(
  input: StitchTranscriptInput,
): Promise<TranscriptArtifact> {
  const state = createStitchState();
  const chunks = input.chunks.toSorted((left, right) => left.chunkIndex - right.chunkIndex);

  for (const chunk of chunks) {
    stitchChunk(state, chunk, await input.readChunk(chunk.chunkIndex));
  }

  return buildTranscriptArtifact(input, state);
}

import type { Asset } from "@cinesim/core";
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

export async function stitchTranscriptChunks(input: {
  asset: Asset;
  sourceFingerprint: SourceFingerprint;
  options: TranscriptGenerationOptions;
  chunks: readonly CompletedTranscriptChunk[];
  readChunk(chunkIndex: number): Promise<StoredGatewayTranscript>;
}): Promise<TranscriptArtifact> {
  const words: TranscriptArtifactWord[] = [];
  const utterances: TranscriptArtifactUtterance[] = [];
  const requestIds = new Set<string>();
  let language: string | null = null;
  let confidenceTotal = 0;
  let confidenceCount = 0;
  for (const chunk of input.chunks.toSorted((left, right) => left.chunkIndex - right.chunkIndex)) {
    const transcript = await input.readChunk(chunk.chunkIndex);
    if (transcript.requestId) requestIds.add(transcript.requestId);
    language ??= transcript.language;
    const localWordIds: string[] = [];
    const localUtteranceIds = new Map<number, string>();
    for (const utterance of transcript.utterances) {
      const utteranceId = `utterance_${String(utterances.length + 1).padStart(6, "0")}`;
      for (const wordIndex of utterance.wordIndexes) localUtteranceIds.set(wordIndex, utteranceId);
      const sourceStartUs = timeUs(
        Math.max(
          chunk.sourceStartUs,
          chunk.sourceStartUs + secondsToTimeUs(timeSeconds(utterance.startSeconds)),
        ),
      );
      const sourceEndUs = timeUs(
        Math.min(
          chunk.sourceEndUs,
          chunk.sourceStartUs + secondsToTimeUs(timeSeconds(utterance.endSeconds)),
        ),
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
    for (let index = 0; index < transcript.words.length; index += 1) {
      const providerWord = transcript.words[index]!;
      const sourceStartUs = timeUs(
        Math.max(
          chunk.sourceStartUs,
          chunk.sourceStartUs + secondsToTimeUs(timeSeconds(providerWord.startSeconds)),
        ),
      );
      const sourceEndUs = timeUs(
        Math.min(
          chunk.sourceEndUs,
          chunk.sourceStartUs + secondsToTimeUs(timeSeconds(providerWord.endSeconds)),
        ),
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
    for (const utterance of transcript.utterances) {
      const utteranceId = localUtteranceIds.get(utterance.wordIndexes[0] ?? -1);
      const output = utterances.find((candidate) => candidate.id === utteranceId);
      if (output)
        output.wordIds = utterance.wordIndexes.flatMap((index) => localWordIds[index] ?? []);
    }
  }
  const requestId = requestIds.size > 0 ? [...requestIds].sort().join(",") : undefined;
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
    language,
    durationUs: input.asset.durationUs,
    ...(confidenceCount > 0 ? { confidence: confidenceTotal / confidenceCount } : {}),
    words,
    utterances: utterances.filter((utterance) => utterance.wordIds.length > 0),
  });
}

import type { Asset } from "@cinesim/core";
import { timeUs } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import type { SourceFingerprint } from "../src/shared/contracts";
import type { TranscriptGenerationOptions } from "../src/shared/transcript";
import type { StoredGatewayTranscript } from "../src/main/transcripts/gateway";
import {
  stitchTranscriptChunks,
  type CompletedTranscriptChunk,
} from "../src/main/transcripts/stitch";

const asset: Asset = {
  id: "asset_dialogue",
  kind: "audio",
  name: "Dialogue.wav",
  source: { kind: "local", path: "/media/dialogue.wav" },
  durationUs: timeUs(10_000_000),
};

const sourceFingerprint: SourceFingerprint = {
  size: 1_024,
  mtimeMs: 42,
  edgeHash: "a".repeat(64),
};

const options: TranscriptGenerationOptions = {
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
  keyterms: [],
};

function chunk(chunkIndex: number, sourceStartUs: number, sourceEndUs: number) {
  return {
    chunkIndex,
    sourceStartUs,
    sourceEndUs,
    responseBytes: 100,
    words: 0,
    utterances: 0,
  } satisfies CompletedTranscriptChunk;
}

describe("transcript chunk stitching", () => {
  it("sorts chunks and connects their words, metadata, and confidence", async () => {
    const chunks = [chunk(1, 5_000_000, 10_000_000), chunk(0, 0, 5_000_000)];
    const transcripts = new Map<number, StoredGatewayTranscript>([
      [
        0,
        {
          requestId: "request-z",
          language: null,
          durationSeconds: 5,
          words: [
            {
              text: "Hello",
              startSeconds: 0.5,
              endSeconds: 1,
              confidence: 0.5,
              speaker: "0",
              paragraphId: "paragraph-a",
              detectedLanguage: "en",
            },
            { text: "there", startSeconds: 1, endSeconds: 1.5 },
          ],
          utterances: [
            {
              id: "provider-a",
              startSeconds: 0.5,
              endSeconds: 1.5,
              speaker: "0",
              confidence: 0.5,
              detectedLanguage: "en",
              wordIndexes: [0, 1],
            },
          ],
        },
      ],
      [
        1,
        {
          requestId: "request-a",
          language: "en",
          durationSeconds: 5,
          words: [{ text: "world", startSeconds: 0.25, endSeconds: 0.75, confidence: 1 }],
          utterances: [
            {
              id: "provider-b",
              startSeconds: 0.25,
              endSeconds: 0.75,
              wordIndexes: [0],
            },
          ],
        },
      ],
    ]);
    const reads: number[] = [];

    const artifact = await stitchTranscriptChunks({
      asset,
      sourceFingerprint,
      options,
      chunks,
      readChunk: async (chunkIndex) => {
        reads.push(chunkIndex);
        return transcripts.get(chunkIndex)!;
      },
    });

    expect(reads).toEqual([0, 1]);
    expect(artifact).toMatchObject({
      language: "en",
      confidence: 0.75,
      generator: { requestId: "request-a,request-z" },
      words: [
        {
          id: "word_000001",
          text: "Hello",
          sourceStartUs: timeUs(500_000),
          sourceEndUs: timeUs(1_000_000),
          utteranceId: "utterance_000001",
        },
        {
          id: "word_000002",
          text: "there",
          sourceStartUs: timeUs(1_000_000),
          sourceEndUs: timeUs(1_500_000),
          utteranceId: "utterance_000001",
        },
        {
          id: "word_000003",
          text: "world",
          sourceStartUs: timeUs(5_250_000),
          sourceEndUs: timeUs(5_750_000),
          utteranceId: "utterance_000002",
        },
      ],
      utterances: [
        { id: "utterance_000001", wordIds: ["word_000001", "word_000002"] },
        { id: "utterance_000002", wordIds: ["word_000003"] },
      ],
    });
  });

  it("clips valid ranges and drops words and empty utterances outside a chunk", async () => {
    const transcript: StoredGatewayTranscript = {
      requestId: null,
      language: "en",
      durationSeconds: 3,
      words: [
        { text: "kept", startSeconds: 0, endSeconds: 3, confidence: 0 },
        { text: "dropped", startSeconds: 2, endSeconds: 3, confidence: 1 },
      ],
      utterances: [
        {
          id: "provider-kept",
          startSeconds: 0,
          endSeconds: 3,
          wordIndexes: [0],
        },
        {
          id: "provider-dropped",
          startSeconds: 2,
          endSeconds: 3,
          wordIndexes: [1],
        },
      ],
    };

    const artifact = await stitchTranscriptChunks({
      asset,
      sourceFingerprint,
      options,
      chunks: [chunk(0, 1_000_000, 2_000_000)],
      readChunk: async () => transcript,
    });

    expect(artifact.confidence).toBe(0);
    expect(artifact.words).toEqual([
      {
        id: "word_000001",
        text: "kept",
        sourceStartUs: timeUs(1_000_000),
        sourceEndUs: timeUs(2_000_000),
        confidence: 0,
        utteranceId: "utterance_000001",
      },
    ]);
    expect(artifact.utterances).toEqual([
      {
        id: "utterance_000001",
        sourceStartUs: timeUs(1_000_000),
        sourceEndUs: timeUs(2_000_000),
        wordIds: ["word_000001"],
      },
    ]);
  });
});

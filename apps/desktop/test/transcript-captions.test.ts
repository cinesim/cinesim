import { timeUs } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import type {
  ProjectedTranscriptWord,
  TranscriptArtifact,
  TranscriptSnapshot,
} from "../src/shared/transcript";
import { captionTrackFromTranscriptSelection } from "../src/shared/transcript";

function word(
  id: string,
  text: string,
  startUs: number,
  endUs: number,
  speaker = "speaker_0",
): ProjectedTranscriptWord {
  return {
    id: `projected_${id}`,
    artifactWordId: id,
    assetId: "asset_dialogue",
    clipId: "clip_dialogue",
    text,
    sourceStartUs: timeUs(startUs),
    sourceEndUs: timeUs(endUs),
    timelineStartUs: timeUs(startUs),
    timelineEndUs: timeUs(endUs),
    speakerClusterId: speaker,
    cutBefore: false,
  };
}

function transcripts(): TranscriptSnapshot {
  const artifact = {
    version: 1,
    assetId: "asset_dialogue",
    sourceFingerprint: { size: 1234, mtimeMs: 42, edgeHash: "edge" },
    generator: { gateway: "direct", provider: "deepgram", model: "deepgram/nova-3", version: 1 },
    options: {},
    language: "en",
    durationUs: timeUs(10_000_000),
    words: [],
    utterances: [],
  } as unknown as TranscriptArtifact;
  return {
    projectDirectory: "/project",
    projectScope: { cacheKey: "project", epoch: "epoch" },
    assets: { asset_dialogue: { assetId: "asset_dialogue", state: "ready", artifact } },
  };
}

describe("transcript caption generation", () => {
  it("creates stable editable cues and relative word timings without retaining artifact authority", () => {
    const words = [
      word("word_1", "Hello", 1_000_000, 1_300_000),
      word("word_2", "world.", 1_350_000, 1_700_000),
      word("word_3", "Next", 2_500_000, 2_800_000),
    ];
    const first = captionTrackFromTranscriptSelection({
      sequenceId: "sequence_main",
      words,
      transcripts: transcripts(),
    });
    const second = captionTrackFromTranscriptSelection({
      sequenceId: "sequence_main",
      words: [...words].reverse(),
      transcripts: transcripts(),
    });

    expect(second).toEqual(first);
    expect(first.transcriptFingerprint).toMatch(/^transcript-v1-[a-f0-9]{16}$/u);
    expect(first.cues).toHaveLength(2);
    expect(first.cues[0]).toMatchObject({
      text: "Hello world.",
      startUs: 1_000_000,
      durationUs: 700_000,
      speaker: "speaker_0",
      words: [
        { text: "Hello", startUs: 0, durationUs: 300_000 },
        { text: "world.", startUs: 350_000, durationUs: 350_000 },
      ],
    });
  });
});

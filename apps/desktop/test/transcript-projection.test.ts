import { describe, expect, it } from "vite-plus/test";
import { applyCommand, createProject, findClip } from "@cinesim/core";
import type { Asset, Project } from "@cinesim/core";
import {
  projectNarrativeUnits,
  projectTimelineTranscript,
  timelinePresentationForHeight,
  timelineRangesForWordIds,
} from "../src/shared/transcript";
import type {
  TranscriptArtifact,
  TranscriptArtifactWord,
  TranscriptSnapshot,
} from "../src/shared/transcript";

const video: Asset = {
  id: "asset_video",
  kind: "video",
  name: "Interview",
  source: { kind: "local", path: "/media/interview.mp4" },
  durationUs: 12_000_000,
  width: 1920,
  height: 1080,
  hasAudio: true,
};

const broll: Asset = {
  id: "asset_broll",
  kind: "video",
  name: "B-roll",
  source: { kind: "local", path: "/media/broll.mp4" },
  durationUs: 5_000_000,
  width: 1920,
  height: 1080,
};

const music: Asset = {
  id: "asset_music",
  kind: "audio",
  name: "Music",
  source: { kind: "local", path: "/media/music.wav" },
  durationUs: 5_000_000,
};

function artifact(assetId: Asset["id"], words: TranscriptArtifactWord[]): TranscriptArtifact {
  return {
    version: 1,
    assetId,
    sourceFingerprint: { size: 100, mtimeMs: 200, edgeHash: "a".repeat(64) },
    generator: {
      gateway: "direct",
      provider: "deepgram",
      model: "deepgram/nova-3",
      version: "deepgram-nova-3@2",
    },
    options: {
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
    },
    language: "en",
    durationUs: 12_000_000,
    words,
    utterances: [],
  };
}

function word(
  id: string,
  text: string,
  sourceStartUs: number,
  sourceEndUs: number,
  speakerClusterId = "speaker-0",
  utteranceId = "utterance-0",
): TranscriptArtifactWord {
  return {
    id,
    text,
    sourceStartUs,
    sourceEndUs,
    confidence: 0.98,
    speakerClusterId,
    utteranceId,
  };
}

function projectWithVideo(): Project {
  let project = createProject({ name: "Transcript" });
  project = applyCommand(project, { type: "asset.import", asset: video }).project;
  project = applyCommand(project, {
    type: "clip.add",
    trackId: "track_000001",
    audioTrackId: "track_000002",
    assetId: video.id,
    timelineStartUs: 0,
  }).project;
  return project;
}

function snapshot(words: TranscriptArtifactWord[]): TranscriptSnapshot {
  return {
    projectDirectory: "/project",
    projectScope: {
      cacheKey: "0123456789abcdef01234567",
      epoch: "123e4567-e89b-12d3-a456-426614174000",
    },
    assets: {
      [video.id]: { assetId: video.id, state: "ready", artifact: artifact(video.id, words) },
    },
  };
}

describe("timeline transcript projection", () => {
  it("maps source words through trims using midpoint inclusion and clamped boundaries", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "clip.trimStart",
      clipId: "clip_000001",
      atUs: 2_000_000,
    }).project;
    project = applyCommand(project, {
      type: "clip.trimEnd",
      clipId: "clip_000001",
      atUs: 8_000_000,
    }).project;
    const transcript = snapshot([
      word("word-0", "outside", 1_000_000, 1_500_000),
      word("word-1", "clamped", 1_800_000, 2_400_000),
      word("word-2", "inside", 4_000_000, 4_500_000),
      word("word-3", "excluded", 7_800_000, 8_400_000),
    ]);

    const projection = projectTimelineTranscript({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: transcript,
    });

    expect(projection.words.map((item) => item.text)).toEqual(["clamped", "inside"]);
    expect(projection.words[0]).toMatchObject({
      artifactWordId: "word-1",
      timelineStartUs: 2_000_000,
      timelineEndUs: 2_400_000,
      cutBefore: true,
    });
    expect(projection.words[1]).toMatchObject({
      timelineStartUs: 4_000_000,
      timelineEndUs: 4_500_000,
    });
  });

  it("deduplicates reciprocal linked clips and keeps artifact mappings", () => {
    const project = projectWithVideo();
    const projection = projectTimelineTranscript({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: snapshot([word("word-0", "Hello", 1_000_000, 1_500_000)]),
    });

    expect(projection.words).toHaveLength(1);
    expect(projection.words[0]).toMatchObject({
      id: "timeline-word:clip_000001:word-0",
      artifactWordId: "word-0",
      clipId: "clip_000001",
      linkedClipId: "clip_000002",
      assetId: video.id,
    });
  });

  it("renders media silence separately from empty timeline gaps", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "clip.split",
      clipId: "clip_000001",
      atUs: 4_000_000,
    }).project;
    project = applyCommand(project, { type: "clip.remove", clipId: "clip_000003" }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      audioTrackId: "track_000002",
      assetId: video.id,
      sourceStartUs: 4_000_000,
      sourceEndUs: 8_000_000,
      timelineStartUs: 6_000_000,
    }).project;
    const projection = projectTimelineTranscript({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: snapshot([
        word("word-0", "We", 500_000, 900_000),
        word("word-1", "paused", 2_000_000, 2_500_000),
        word("word-2", "then", 4_500_000, 5_000_000),
      ]),
      silenceThresholdUs: 500_000,
    });

    const utterance = projection.blocks.find((block) => block.kind === "utterance");
    expect(utterance?.kind === "utterance" ? utterance.utterance.tokens : []).toContainEqual(
      expect.objectContaining({
        kind: "media-silence",
        timelineStartUs: 900_000,
        timelineEndUs: 2_000_000,
      }),
    );
    expect(projection.blocks).toContainEqual(
      expect.objectContaining({
        kind: "timeline-gap",
        gap: expect.objectContaining({ timelineStartUs: 2_500_000, timelineEndUs: 6_500_000 }),
      }),
    );
  });

  it("shows clip cuts without duplicating prose", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "clip.split",
      clipId: "clip_000001",
      atUs: 4_000_000,
    }).project;
    const projection = projectTimelineTranscript({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: snapshot([
        word("word-0", "Before", 3_000_000, 3_500_000),
        word("word-1", "after", 4_500_000, 5_000_000),
      ]),
    });
    expect(projection.words.map((item) => item.text)).toEqual(["Before", "after"]);
    expect(projection.words[1]?.cutBefore).toBe(true);
  });

  it("keeps missing and failed transcript coverage visible", () => {
    const project = projectWithVideo();
    const projection = projectTimelineTranscript({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: {
        projectDirectory: "/project",
        projectScope: {
          cacheKey: "0123456789abcdef01234567",
          epoch: "123e4567-e89b-12d3-a456-426614174000",
        },
        assets: {
          [video.id]: { assetId: video.id, state: "failed", failureCode: "provider_timeout" },
        },
      },
    });
    expect(projection.words).toEqual([]);
    expect(projection.coverage).toEqual([
      expect.objectContaining({
        clipId: "clip_000001",
        state: "failed",
        failureCode: "provider_timeout",
      }),
    ]);
  });

  it("maps selected words back to exact disjoint canonical clip ranges", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "clip.split",
      clipId: "clip_000001",
      atUs: 4_000_000,
    }).project;
    const projection = projectTimelineTranscript({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: snapshot([
        word("word-0", "One", 1_000_000, 1_400_000),
        word("word-1", "two", 2_000_000, 2_400_000),
        word("word-2", "three", 5_000_000, 5_400_000),
      ]),
    });
    const selected = new Set(projection.words.map((item) => item.id));
    expect(timelineRangesForWordIds(projection.words, selected)).toEqual([
      { startUs: 1_000_000, endUs: 2_400_000 },
      { startUs: 5_000_000, endUs: 5_400_000 },
    ]);
  });
});

describe("collapsed timeline narrative projection", () => {
  it("projects linked dialogue once and annotates overlapping B-roll and music", () => {
    let project = projectWithVideo();
    project = applyCommand(project, { type: "asset.import", asset: broll }).project;
    project = applyCommand(project, { type: "asset.import", asset: music }).project;
    project = applyCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "overlay",
      name: "B-roll",
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000003",
      assetId: broll.id,
      timelineStartUs: 2_000_000,
    }).project;
    project = applyCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "audio",
      name: "Music",
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000004",
      assetId: music.id,
      timelineStartUs: 5_000_000,
    }).project;

    const units = projectNarrativeUnits({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: snapshot([word("word-0", "Dialogue", 1_000_000, 2_000_000)]),
    });

    expect(units).toEqual([
      expect.objectContaining({
        kind: "dialogue",
        clipIds: ["clip_000001", "clip_000002"],
        hasVisualOverlay: true,
        hasSecondaryAudio: true,
      }),
    ]);
  });

  it("represents overlapping transcript-bearing clips as one interval", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "video",
      name: "Second speaker",
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000003",
      assetId: video.id,
      sourceEndUs: 5_000_000,
      timelineStartUs: 2_000_000,
    }).project;
    const units = projectNarrativeUnits({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: snapshot([word("word-0", "Dialogue", 1_000_000, 2_000_000)]),
    });
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      label: "Overlapping dialogue",
      hasOverlappingDialogue: true,
      timelineStartUs: 0,
      timelineEndUs: 12_000_000,
    });
  });

  it("uses deterministic height presentation thresholds", () => {
    expect(timelinePresentationForHeight(64)).toBe("collapsed");
    expect(timelinePresentationForHeight(119)).toBe("collapsed");
    expect(timelinePresentationForHeight(120)).toBe("compact");
    expect(timelinePresentationForHeight(259)).toBe("compact");
    expect(timelinePresentationForHeight(260)).toBe("full");
  });

  it("keeps canonical selection stable after a projected split", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "sequence.deleteRanges",
      sequenceId: project.activeSequenceId,
      ranges: [{ startUs: 2_000_000, endUs: 3_000_000 }],
      mode: "ripple",
    }).project;
    expect(findClip(project, "clip_000003").clip.timelineStartUs).toBe(2_000_000);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { timeUs, findClip } from "@cinesim/core";
import type { Asset, Project } from "@cinesim/core";
import { applyCommand, createProject } from "../../../packages/core/test/project-fixtures";
import {
  projectNarrativeUnits,
  projectTimelineTranscript,
  timelinePresentationForHeight,
  timelineRangesForWordIds,
  transcriptDocumentSections,
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
  durationUs: timeUs(12_000_000),
  width: 1920,
  height: 1080,
  hasAudio: true,
};

const broll: Asset = {
  id: "asset_broll",
  kind: "video",
  name: "B-roll",
  source: { kind: "local", path: "/media/broll.mp4" },
  durationUs: timeUs(5_000_000),
  width: 1920,
  height: 1080,
};

const music: Asset = {
  id: "asset_music",
  kind: "audio",
  name: "Music",
  source: { kind: "local", path: "/media/music.wav" },
  durationUs: timeUs(5_000_000),
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
      version: "deepgram-nova-3@3",
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
    durationUs: timeUs(12_000_000),
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
    sourceStartUs: timeUs(sourceStartUs),
    sourceEndUs: timeUs(sourceEndUs),
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
    timelineStartUs: timeUs(0),
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
      atUs: timeUs(2_000_000),
    }).project;
    project = applyCommand(project, {
      type: "clip.trimEnd",
      clipId: "clip_000001",
      atUs: timeUs(8_000_000),
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
      timelineStartUs: timeUs(2_000_000),
      timelineEndUs: timeUs(2_400_000),
      cutBefore: true,
    });
    expect(projection.words[1]).toMatchObject({
      timelineStartUs: timeUs(4_000_000),
      timelineEndUs: timeUs(4_500_000),
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

  it("gives speaker-split rows unique IDs when Deepgram reuses an utterance ID", () => {
    const project = projectWithVideo();
    const projection = projectTimelineTranscript({
      project,
      sequenceId: project.activeSequenceId,
      transcripts: snapshot([
        word("word-0", "First", 1_000_000, 1_500_000, "speaker-0", "utterance-shared"),
        word("word-1", "Second", 2_600_000, 3_100_000, "speaker-1", "utterance-shared"),
      ]),
    });
    const utterances = projection.blocks.flatMap((block) =>
      block.kind === "utterance" ? [block.utterance] : [],
    );

    expect(utterances.map((utterance) => utterance.id)).toEqual([
      "utterance:clip_000001:utterance-shared",
      "utterance:clip_000001:utterance-shared:segment-2",
    ]);
    expect(new Set(utterances.map((utterance) => utterance.id)).size).toBe(2);
    const sections = transcriptDocumentSections(projection.blocks);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      kind: "paragraph",
      paragraph: { clipId: "clip_000001" },
    });
    expect(
      sections[0]?.kind === "paragraph"
        ? sections[0].paragraph.blocks.filter((block) => block.kind === "utterance")
        : [],
    ).toHaveLength(2);
    expect(
      sections[0]?.kind === "paragraph"
        ? sections[0].paragraph.blocks.some((block) => block.kind === "timeline-gap")
        : false,
    ).toBe(true);
  });

  it("renders media silence separately from empty timeline gaps", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "clip.split",
      clipId: "clip_000001",
      atUs: timeUs(4_000_000),
    }).project;
    project = applyCommand(project, { type: "clip.remove", clipId: "clip_000003" }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      audioTrackId: "track_000002",
      assetId: video.id,
      sourceStartUs: timeUs(4_000_000),
      sourceEndUs: timeUs(8_000_000),
      timelineStartUs: timeUs(6_000_000),
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
        timelineStartUs: timeUs(900_000),
        timelineEndUs: timeUs(2_000_000),
      }),
    );
    expect(projection.blocks).toContainEqual(
      expect.objectContaining({
        kind: "timeline-gap",
        gap: expect.objectContaining({
          timelineStartUs: timeUs(2_500_000),
          timelineEndUs: timeUs(6_500_000),
        }),
      }),
    );
    const paragraphs = transcriptDocumentSections(projection.blocks).filter(
      (section) => section.kind === "paragraph",
    );
    expect(paragraphs).toHaveLength(2);
    expect(
      paragraphs[0]?.kind === "paragraph" ? paragraphs[0].paragraph.blocks : [],
    ).toContainEqual(expect.objectContaining({ kind: "timeline-gap" }));
  });

  it("shows clip cuts without duplicating prose", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "clip.split",
      clipId: "clip_000001",
      atUs: timeUs(4_000_000),
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
      atUs: timeUs(4_000_000),
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
      { startUs: timeUs(1_000_000), endUs: timeUs(2_400_000) },
      { startUs: timeUs(5_000_000), endUs: timeUs(5_400_000) },
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
      timelineStartUs: timeUs(2_000_000),
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
      timelineStartUs: timeUs(5_000_000),
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
      sourceEndUs: timeUs(5_000_000),
      timelineStartUs: timeUs(2_000_000),
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
      timelineStartUs: timeUs(0),
      timelineEndUs: timeUs(12_000_000),
    });
  });

  it("uses deterministic height presentation thresholds", () => {
    expect(timelinePresentationForHeight(64)).toBe("collapsed");
    expect(timelinePresentationForHeight(119)).toBe("collapsed");
    expect(timelinePresentationForHeight(120)).toBe("full");
    expect(timelinePresentationForHeight(259)).toBe("full");
    expect(timelinePresentationForHeight(260)).toBe("full");
  });

  it("keeps canonical selection stable after a projected split", () => {
    let project = projectWithVideo();
    project = applyCommand(project, {
      type: "sequence.deleteRanges",
      sequenceId: project.activeSequenceId,
      ranges: [{ startUs: timeUs(2_000_000), endUs: timeUs(3_000_000) }],
      mode: "ripple",
    }).project;
    expect(findClip(project, "clip_000003").clip.timelineStartUs).toBe(2_000_000);
  });
});

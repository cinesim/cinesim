import { irTimeUs, type IrCaptionCue, type IrCaptionTrack, type IrValue } from "@cinesim/ir";
import type { ProjectedTranscriptWord, TranscriptSnapshot } from "./projection-types";

const MAX_CUE_WORDS = 8;
const MAX_CUE_CHARACTERS = 42;
const MAX_CUE_DURATION_US = 5_000_000;
const MAX_WORD_GAP_US = 400_000;

function stableHash(value: string): string {
  let first = 2_166_136_261;
  let second = 2_166_136_261 ^ 0x9e37_79b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ code, 2_246_822_519);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function transcriptSourceFingerprint(
  words: readonly ProjectedTranscriptWord[],
  snapshot: TranscriptSnapshot,
): { fingerprint: string; language?: string } {
  const assetIds = [...new Set(words.map(({ assetId }) => assetId))].sort();
  const artifacts = assetIds.flatMap((assetId) => {
    const artifact = snapshot.assets[assetId]?.artifact;
    if (!artifact) return [];
    const source = artifact.sourceFingerprint;
    return [
      `${assetId}:${source.size}:${source.mtimeMs}:${source.edgeHash}:${artifact.generator.provider}:${artifact.generator.model}:${artifact.generator.version}`,
    ];
  });
  if (artifacts.length !== assetIds.length)
    throw new Error("Every selected transcript word must have a current source artifact");
  const languages = [
    ...new Set(
      assetIds.flatMap((assetId) => {
        const language = snapshot.assets[assetId]?.artifact?.language;
        return language ? [language] : [];
      }),
    ),
  ];
  return {
    fingerprint: `transcript-v1-${stableHash(artifacts.join("|"))}`,
    ...(languages.length === 1 ? { language: languages[0] } : {}),
  };
}

function cueText(words: readonly ProjectedTranscriptWord[]): string {
  return words.reduce((text, word) => {
    if (!text) return word.text;
    return /^[,.:;!?)]/u.test(word.text) ? `${text}${word.text}` : `${text} ${word.text}`;
  }, "");
}

function shouldBreakCue(
  cue: readonly ProjectedTranscriptWord[],
  word: ProjectedTranscriptWord,
): boolean {
  const first = cue[0];
  const previous = cue.at(-1);
  if (!first || !previous) return false;
  return (
    previous.clipId !== word.clipId ||
    previous.speakerClusterId !== word.speakerClusterId ||
    word.timelineStartUs - previous.timelineEndUs > MAX_WORD_GAP_US ||
    word.timelineEndUs - first.timelineStartUs > MAX_CUE_DURATION_US ||
    cue.length >= MAX_CUE_WORDS ||
    cueText([...cue, word]).length > MAX_CUE_CHARACTERS
  );
}

function cueGroups(words: readonly ProjectedTranscriptWord[]): ProjectedTranscriptWord[][] {
  const groups: ProjectedTranscriptWord[][] = [];
  for (const word of words) {
    const current = groups.at(-1);
    if (!current || shouldBreakCue(current, word)) groups.push([word]);
    else current.push(word);
  }
  return groups;
}

function captionCue(words: readonly ProjectedTranscriptWord[]): IrCaptionCue {
  const first = words[0]!;
  const last = words.at(-1)!;
  const cueStartUs = first.timelineStartUs;
  const identity = words
    .map(({ assetId, artifactWordId }) => `${assetId}:${artifactWordId}`)
    .join("|");
  return {
    id: `cue_${stableHash(identity)}`,
    startUs: irTimeUs(cueStartUs),
    durationUs: irTimeUs(last.timelineEndUs - cueStartUs),
    text: cueText(words),
    ...(first.speakerClusterId ? { speaker: first.speakerClusterId } : {}),
    props: {},
    animations: [],
    words: words.map((word) => ({
      id: `captionword_${stableHash(`${word.assetId}:${word.artifactWordId}:${word.timelineStartUs}`)}`,
      startUs: irTimeUs(word.timelineStartUs - cueStartUs),
      durationUs: irTimeUs(word.timelineEndUs - word.timelineStartUs),
      text: word.text,
    })),
  };
}

function defaultCaptionStyle(): Record<string, IrValue> {
  return {
    fontFamily: { kind: "string", value: "Instrument Sans" },
    fontSize: { kind: "length", unit: "px", value: 64 },
    fontWeight: { kind: "number", value: 600 },
    lineHeight: { kind: "number", value: 1.15 },
    placement: { kind: "string", value: "bottom" },
    align: { kind: "string", value: "center" },
    fill: { kind: "color", value: "#ffffff" },
    outlineColor: { kind: "color", value: "#000000" },
    outlineWidth: { kind: "length", unit: "px", value: 3 },
    shadowColor: { kind: "color", value: "#00000099" },
    shadowBlur: { kind: "length", unit: "px", value: 8 },
    shadowX: { kind: "length", unit: "px", value: 0 },
    shadowY: { kind: "length", unit: "px", value: 4 },
    background: { kind: "color", value: "#00000000" },
    safeMarginX: { kind: "percent", value: 8 },
    safeMarginY: { kind: "percent", value: 8 },
    animationPreset: { kind: "string", value: "none" },
    emphasisFill: { kind: "color", value: "#ffd54a" },
    emphasisScale: { kind: "number", value: 1.08 },
  };
}

export function captionTrackFromTranscriptSelection(input: {
  sequenceId: string;
  words: readonly ProjectedTranscriptWord[];
  transcripts: TranscriptSnapshot;
}): IrCaptionTrack {
  const words = [...input.words].sort(
    (left, right) =>
      left.timelineStartUs - right.timelineStartUs || left.id.localeCompare(right.id),
  );
  if (words.length === 0) throw new Error("Select transcript words before generating captions");
  const source = transcriptSourceFingerprint(words, input.transcripts);
  const selection = `${input.sequenceId}:${source.fingerprint}:${words[0]!.id}:${words.at(-1)!.id}`;
  return {
    id: `captiontrack_${stableHash(selection)}`,
    name: "Generated captions",
    transcriptFingerprint: source.fingerprint,
    ...(source.language ? { language: source.language } : {}),
    props: defaultCaptionStyle(),
    cues: cueGroups(words).map(captionCue),
  };
}

import type { AssetId, ClipId, Project, Sequence, TimeUs } from "@cinesim/core";
import { clipEndUs, timeUs } from "@cinesim/core";
import type { TranscriptArtifact } from "./artifact";
import { DEFAULT_SILENCE_THRESHOLD_US } from "./constants";
import type {
  NarrativeUnit,
  ProjectedTranscriptWord,
  ProjectedUtterance,
  TimelinePresentation,
  TimelineTranscriptProjection,
  TranscriptAssetSnapshot,
  TranscriptCoveragePlaceholder,
  TranscriptDocumentBlock,
  TranscriptDocumentParagraph,
  TranscriptDocumentSection,
  TranscriptSnapshot,
} from "./projection-types";

export function transcriptDocumentSections(
  blocks: readonly TranscriptDocumentBlock[],
): TranscriptDocumentSection[] {
  const sections: TranscriptDocumentSection[] = [];
  let paragraph: TranscriptDocumentParagraph | null = null;
  let paragraphIndex = 0;
  const flushParagraph = () => {
    if (!paragraph) return;
    sections.push({ kind: "paragraph", paragraph });
    paragraph = null;
  };

  for (const block of blocks) {
    if (block.kind === "coverage") {
      flushParagraph();
      sections.push(block);
      continue;
    }
    if (block.kind === "timeline-gap") {
      if (paragraph) paragraph.blocks.push(block);
      continue;
    }
    if (!paragraph || paragraph.clipId !== block.utterance.clipId) {
      flushParagraph();
      paragraphIndex += 1;
      paragraph = {
        id: `paragraph:${block.utterance.clipId}:${paragraphIndex}`,
        clipId: block.utterance.clipId,
        blocks: [],
      };
    }
    paragraph.blocks.push(block);
  }
  flushParagraph();
  return sections;
}

interface NarrativeClipGroup {
  key: string;
  clipIds: ClipId[];
  assetId: AssetId;
  name: string;
  startUs: TimeUs;
  endUs: TimeUs;
  transcriptBearing: boolean;
  speakerClusterIds: string[];
  supportingVisual: boolean;
  supportingAudio: boolean;
}

function selectedSequence(project: Project, sequenceId: string): Sequence {
  const sequence = project.sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) throw new Error(`Sequence not found: ${sequenceId}`);
  return sequence;
}

function reciprocalGroupKey(clipId: ClipId, linkedClipId?: ClipId): string {
  return linkedClipId && linkedClipId.localeCompare(clipId) < 0 ? linkedClipId : clipId;
}

function narrativeClips(sequence: Sequence) {
  const emitted = new Set<string>();
  return sequence.tracks.flatMap((track) =>
    track.clips.flatMap((clip) => {
      const key = reciprocalGroupKey(clip.id, clip.linkedClipId);
      if (emitted.has(key)) return [];
      emitted.add(key);
      const linked = clip.linkedClipId
        ? sequence.tracks
            .flatMap((candidate) => candidate.clips)
            .find((item) => item.id === clip.linkedClipId)
        : undefined;
      const primary = clip.mediaKind === "video" ? clip : (linked ?? clip);
      return [{ clip: primary, linkedClip: linked?.id === primary.id ? clip : linked, track, key }];
    }),
  );
}

function wordsForClip(
  clip: ReturnType<typeof narrativeClips>[number]["clip"],
  artifact: TranscriptArtifact,
): ProjectedTranscriptWord[] {
  const clipEnd = clipEndUs(clip);
  const words = artifact.words.flatMap((word) => {
    const midpointUs = word.sourceStartUs + (word.sourceEndUs - word.sourceStartUs) / 2;
    if (midpointUs < clip.sourceStartUs || midpointUs >= clip.sourceEndUs) return [];
    const timelineStartUs = timeUs(
      Math.max(
        clip.timelineStartUs,
        clip.timelineStartUs + word.sourceStartUs - clip.sourceStartUs,
      ),
    );
    const timelineEndUs = timeUs(
      Math.min(clipEnd, clip.timelineStartUs + word.sourceEndUs - clip.sourceStartUs),
    );
    if (timelineEndUs <= timelineStartUs) return [];
    return [
      {
        ...word,
        id: `timeline-word:${clip.id}:${word.id}`,
        artifactWordId: word.id,
        assetId: clip.assetId,
        clipId: clip.id,
        ...(clip.linkedClipId ? { linkedClipId: clip.linkedClipId } : {}),
        timelineStartUs,
        timelineEndUs,
        cutBefore: false,
      },
    ];
  });
  const first = words[0];
  if (first && clip.sourceStartUs > 0) first.cutBefore = true;
  return words;
}

function belongsToUtterance(
  current: ProjectedUtterance | undefined,
  word: ProjectedTranscriptWord,
): current is ProjectedUtterance {
  return Boolean(
    current &&
    current.clipId === word.clipId &&
    current.speakerClusterId === word.speakerClusterId &&
    current.tokens.some(
      (token) => token.kind === "word" && token.word.utteranceId === word.utteranceId,
    ),
  );
}

function createUtterance(
  word: ProjectedTranscriptWord,
  segmentCounts: Map<string, number>,
): ProjectedUtterance {
  const baseId = `utterance:${word.clipId}:${word.utteranceId ?? word.id}`;
  const segment = (segmentCounts.get(baseId) ?? 0) + 1;
  segmentCounts.set(baseId, segment);
  return {
    id: segment === 1 ? baseId : `${baseId}:segment-${segment}`,
    assetId: word.assetId,
    clipId: word.clipId,
    ...(word.linkedClipId ? { linkedClipId: word.linkedClipId } : {}),
    ...(word.speakerClusterId ? { speakerClusterId: word.speakerClusterId } : {}),
    timelineStartUs: word.timelineStartUs,
    timelineEndUs: word.timelineEndUs,
    overlapping: false,
    tokens: [{ kind: "word", word }],
  };
}

function appendWord(
  utterance: ProjectedUtterance,
  word: ProjectedTranscriptWord,
  silenceThresholdUs: number,
): void {
  const previousToken = utterance.tokens.findLast((token) => token.kind === "word");
  const previousWord = previousToken?.kind === "word" ? previousToken.word : null;
  if (previousWord && word.timelineStartUs - previousWord.timelineEndUs >= silenceThresholdUs) {
    utterance.tokens.push({
      id: `silence:${word.clipId}:${previousWord.id}:${word.id}`,
      kind: "media-silence",
      assetId: word.assetId,
      clipId: word.clipId,
      timelineStartUs: previousWord.timelineEndUs,
      timelineEndUs: word.timelineStartUs,
    });
  }
  utterance.tokens.push({ kind: "word", word });
  utterance.timelineEndUs = word.timelineEndUs;
}

function markOverlaps(utterances: ProjectedUtterance[]): void {
  for (let index = 0; index < utterances.length; index += 1) {
    const utterance = utterances[index];
    if (!utterance) continue;
    utterance.overlapping = utterances.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.timelineStartUs < utterance.timelineEndUs &&
        other.timelineEndUs > utterance.timelineStartUs,
    );
  }
}

function utterancesForWords(
  words: readonly ProjectedTranscriptWord[],
  silenceThresholdUs: number,
): ProjectedUtterance[] {
  const utterances: ProjectedUtterance[] = [];
  const segmentCounts = new Map<string, number>();
  for (const word of words) {
    const current = utterances.at(-1);
    if (belongsToUtterance(current, word)) appendWord(current, word, silenceThresholdUs);
    else utterances.push(createUtterance(word, segmentCounts));
  }
  markOverlaps(utterances);
  return utterances;
}

function missingCoverage(
  clip: ReturnType<typeof narrativeClips>[number]["clip"],
  record: TranscriptAssetSnapshot | undefined,
): TranscriptCoveragePlaceholder {
  const state = record?.state === "ready" ? "failed" : (record?.state ?? "missing");
  const failureCode = record?.state === "ready" ? "artifact_missing" : record?.failureCode;
  return {
    id: `coverage:${clip.id}`,
    assetId: clip.assetId,
    clipId: clip.id,
    timelineStartUs: clip.timelineStartUs,
    timelineEndUs: clipEndUs(clip),
    state,
    ...(failureCode ? { failureCode } : {}),
  };
}

function collectTranscriptContent(
  sequence: Sequence,
  transcripts: TranscriptSnapshot | null,
): Pick<TimelineTranscriptProjection, "words" | "coverage"> {
  const words: ProjectedTranscriptWord[] = [];
  const coverage: TranscriptCoveragePlaceholder[] = [];
  for (const { clip, linkedClip } of narrativeClips(sequence)) {
    const record = transcripts?.assets[clip.assetId];
    if (record?.state !== "ready" || !record.artifact) {
      coverage.push(missingCoverage(clip, record));
      continue;
    }
    words.push(
      ...wordsForClip(
        { ...clip, ...(linkedClip ? { linkedClipId: linkedClip.id } : {}) },
        record.artifact,
      ),
    );
  }
  return { words, coverage };
}

function blockStartUs(block: TranscriptDocumentBlock): TimeUs {
  if (block.kind === "utterance") return block.utterance.timelineStartUs;
  if (block.kind === "coverage") return block.coverage.timelineStartUs;
  return block.gap.timelineStartUs;
}

function blockEndUs(block: TranscriptDocumentBlock): TimeUs {
  if (block.kind === "utterance") return block.utterance.timelineEndUs;
  if (block.kind === "coverage") return block.coverage.timelineEndUs;
  return block.gap.timelineEndUs;
}

function insertTimelineGaps(
  content: readonly TranscriptDocumentBlock[],
  silenceThresholdUs: number,
): TranscriptDocumentBlock[] {
  const blocks: TranscriptDocumentBlock[] = [];
  for (const block of content) {
    const previous = blocks.at(-1);
    const previousEnd = previous && blockEndUs(previous);
    const blockStart = blockStartUs(block);
    if (previousEnd !== undefined && blockStart - previousEnd >= silenceThresholdUs) {
      blocks.push({
        kind: "timeline-gap",
        gap: {
          id: `gap:${previousEnd}:${blockStart}`,
          kind: "timeline-gap",
          timelineStartUs: previousEnd,
          timelineEndUs: blockStart,
        },
      });
    }
    blocks.push(block);
  }
  return blocks;
}

export function projectTimelineTranscript(input: {
  project: Project;
  sequenceId: string;
  transcripts: TranscriptSnapshot | null;
  silenceThresholdUs?: number;
}): TimelineTranscriptProjection {
  const sequence = selectedSequence(input.project, input.sequenceId);
  const silenceThresholdUs = input.silenceThresholdUs ?? DEFAULT_SILENCE_THRESHOLD_US;
  const { words, coverage } = collectTranscriptContent(sequence, input.transcripts);

  words.sort(
    (left, right) =>
      left.timelineStartUs - right.timelineStartUs ||
      left.clipId.localeCompare(right.clipId) ||
      left.id.localeCompare(right.id),
  );
  coverage.sort(
    (left, right) =>
      left.timelineStartUs - right.timelineStartUs || left.clipId.localeCompare(right.clipId),
  );
  const utterances = utterancesForWords(words, silenceThresholdUs);
  const contentBlocks: TranscriptDocumentBlock[] = [
    ...utterances.map((utterance) => ({ kind: "utterance" as const, utterance })),
    ...coverage.map((item) => ({ kind: "coverage" as const, coverage: item })),
  ].sort((left, right) => blockStartUs(left) - blockStartUs(right));
  return { blocks: insertTimelineGaps(contentBlocks, silenceThresholdUs), words, coverage };
}

function intersects(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function narrativeGroups(
  project: Project,
  sequence: Sequence,
  transcripts: TranscriptSnapshot | null,
): NarrativeClipGroup[] {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  return narrativeClips(sequence).map(({ clip, linkedClip, key, track }) => {
    const artifact = transcripts?.assets[clip.assetId]?.artifact;
    const projectedWords = artifact ? wordsForClip(clip, artifact) : [];
    return {
      key,
      clipIds: [clip.id, ...(linkedClip ? [linkedClip.id] : [])].sort(),
      assetId: clip.assetId,
      name: assets.get(clip.assetId)?.name ?? clip.assetId,
      startUs: clip.timelineStartUs,
      endUs: clipEndUs(clip),
      transcriptBearing: projectedWords.length > 0,
      speakerClusterIds: [
        ...new Set(projectedWords.flatMap((word) => word.speakerClusterId ?? [])),
      ].sort(),
      supportingVisual: track.kind === "overlay",
      supportingAudio: track.kind === "audio" && !artifact,
    };
  });
}

function dialogueUnit(group: NarrativeClipGroup): NarrativeUnit {
  return {
    id: `narrative:${group.key}`,
    kind: "dialogue",
    label: group.name,
    timelineStartUs: group.startUs,
    timelineEndUs: group.endUs,
    clipIds: group.clipIds,
    speakerClusterIds: group.speakerClusterIds,
    hasVisualOverlay: false,
    hasSecondaryAudio: false,
    hasOverlappingDialogue: false,
  };
}

function mergeDialogue(unit: NarrativeUnit, group: NarrativeClipGroup): void {
  unit.timelineEndUs = timeUs(Math.max(unit.timelineEndUs, group.endUs));
  unit.clipIds = [...new Set([...unit.clipIds, ...group.clipIds])].sort();
  unit.speakerClusterIds = [
    ...new Set([...unit.speakerClusterIds, ...group.speakerClusterIds]),
  ].sort();
  unit.hasOverlappingDialogue = true;
  unit.label = "Overlapping dialogue";
}

function dialogueUnits(groups: readonly NarrativeClipGroup[]): NarrativeUnit[] {
  const units: NarrativeUnit[] = [];
  const dialogue = groups
    .filter((group) => group.transcriptBearing)
    .sort((left, right) => left.startUs - right.startUs || left.key.localeCompare(right.key));
  for (const group of dialogue) {
    const previous = units.at(-1);
    if (previous && group.startUs < previous.timelineEndUs) mergeDialogue(previous, group);
    else units.push(dialogueUnit(group));
  }
  return units;
}

function applySupportingFlags(
  units: readonly NarrativeUnit[],
  supporting: readonly NarrativeClipGroup[],
): void {
  for (const unit of units) {
    for (const group of supporting) {
      if (!intersects(unit.timelineStartUs, unit.timelineEndUs, group.startUs, group.endUs))
        continue;
      unit.hasVisualOverlay ||= group.supportingVisual;
      unit.hasSecondaryAudio ||= group.supportingAudio;
    }
  }
}

function nonDialogueUnit(group: NarrativeClipGroup): NarrativeUnit {
  return {
    id: `narrative:${group.key}`,
    kind: "non-dialogue",
    label: group.name,
    timelineStartUs: group.startUs,
    timelineEndUs: group.endUs,
    clipIds: group.clipIds,
    speakerClusterIds: [],
    hasVisualOverlay: group.supportingVisual,
    hasSecondaryAudio: group.supportingAudio,
    hasOverlappingDialogue: false,
  };
}

function unpairedSupportingUnits(
  units: readonly NarrativeUnit[],
  supporting: readonly NarrativeClipGroup[],
): NarrativeUnit[] {
  return supporting.flatMap((group) => {
    const overlapsDialogue = units.some((unit) =>
      intersects(unit.timelineStartUs, unit.timelineEndUs, group.startUs, group.endUs),
    );
    return overlapsDialogue ? [] : [nonDialogueUnit(group)];
  });
}

export function projectNarrativeUnits(input: {
  project: Project;
  sequenceId: string;
  transcripts: TranscriptSnapshot | null;
}): NarrativeUnit[] {
  const sequence = selectedSequence(input.project, input.sequenceId);
  const groups = narrativeGroups(input.project, sequence, input.transcripts);
  const supporting = groups.filter((group) => !group.transcriptBearing);
  const units = dialogueUnits(groups);
  applySupportingFlags(units, supporting);
  units.push(...unpairedSupportingUnits(units, supporting));
  return units.sort(
    (left, right) =>
      left.timelineStartUs - right.timelineStartUs || left.id.localeCompare(right.id),
  );
}

export function timelinePresentationForHeight(height: number): TimelinePresentation {
  if (height >= 120) return "full";
  return "collapsed";
}

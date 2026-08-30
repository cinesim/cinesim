import type { AssetId, ClipId, TimeUs } from "@cinesim/core";
import type { DerivedProjectScope } from "../contracts";
import type { TranscriptArtifact, TranscriptArtifactWord } from "./artifact";

export type TranscriptJobState = "missing" | "queued" | "running" | "ready" | "failed";

export interface TranscriptAssetSnapshot {
  assetId: AssetId;
  state: TranscriptJobState;
  progress?: number;
  failureCode?: string;
  artifact?: TranscriptArtifact;
}

export interface TranscriptSnapshot {
  projectDirectory: string;
  projectScope: DerivedProjectScope;
  assets: Partial<Record<AssetId, TranscriptAssetSnapshot>>;
}

export interface ProjectedTranscriptWord extends TranscriptArtifactWord {
  artifactWordId: string;
  assetId: AssetId;
  clipId: ClipId;
  linkedClipId?: ClipId;
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
  cutBefore: boolean;
}

export interface ProjectedSilenceToken {
  id: string;
  kind: "media-silence";
  assetId: AssetId;
  clipId: ClipId;
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
}

export interface ProjectedTimelineGap {
  id: string;
  kind: "timeline-gap";
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
}

export type TranscriptInlineToken =
  | { kind: "word"; word: ProjectedTranscriptWord }
  | ProjectedSilenceToken;

export interface ProjectedUtterance {
  id: string;
  assetId: AssetId;
  clipId: ClipId;
  linkedClipId?: ClipId;
  speakerClusterId?: string;
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
  overlapping: boolean;
  tokens: TranscriptInlineToken[];
}

export interface TranscriptCoveragePlaceholder {
  id: string;
  assetId: AssetId;
  clipId: ClipId;
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
  state: Exclude<TranscriptJobState, "ready">;
  failureCode?: string;
}

export type TranscriptDocumentBlock =
  | { kind: "utterance"; utterance: ProjectedUtterance }
  | { kind: "timeline-gap"; gap: ProjectedTimelineGap }
  | { kind: "coverage"; coverage: TranscriptCoveragePlaceholder };

export interface TranscriptDocumentParagraph {
  id: string;
  clipId: ClipId;
  blocks: Array<Exclude<TranscriptDocumentBlock, { kind: "coverage" }>>;
}

export type TranscriptDocumentSection =
  | { kind: "paragraph"; paragraph: TranscriptDocumentParagraph }
  | Extract<TranscriptDocumentBlock, { kind: "coverage" }>;

export interface TimelineTranscriptProjection {
  blocks: TranscriptDocumentBlock[];
  words: ProjectedTranscriptWord[];
  coverage: TranscriptCoveragePlaceholder[];
}

export interface NarrativeUnit {
  id: string;
  kind: "dialogue" | "non-dialogue";
  label: string;
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
  clipIds: ClipId[];
  speakerClusterIds: string[];
  hasVisualOverlay: boolean;
  hasSecondaryAudio: boolean;
  hasOverlappingDialogue: boolean;
}

export type TimelinePresentation = "collapsed" | "full";

import type {
  CutLayoutState,
  EditorLayoutState,
  TranscriptionSettings,
} from "./contracts/app-state";

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  generation: "manual",
  model: "deepgram/nova-3",
};

export const DEFAULT_EDITOR_LAYOUT: EditorLayoutState = {
  mediaPoolWidth: 248,
  inspectorWidth: 260,
  notesWidth: 300,
  timelineHeight: 288,
};

export const EDITOR_LAYOUT_LIMITS = {
  mediaPoolWidth: { min: 180, max: 480 },
  inspectorWidth: { min: 220, max: 480 },
  notesWidth: { min: 220, max: 480 },
  timelineHeight: { min: 64, max: 720 },
} as const;

export const DEFAULT_CUT_LAYOUT: CutLayoutState = {
  rightColumnWidth: 420,
  viewerHeight: 360,
  timelineHeight: 80,
};

export const CUT_LAYOUT_LIMITS = {
  rightColumnWidth: { min: 300, max: 680 },
  viewerHeight: { min: 220, max: 720 },
  timelineHeight: { min: 64, max: 720 },
} as const;

export interface RecentProject {
  name: string;
  directory: string;
  kind: "local" | "cloud";
}

export interface EditorLayoutState {
  mediaPoolWidth: number;
  inspectorWidth: number;
  notesWidth: number;
  timelineHeight: number;
}

export interface CutLayoutState {
  rightColumnWidth: number;
  viewerHeight: number;
  timelineHeight: number;
}

export type TranscriptionModel = "deepgram/nova-3";

export interface TranscriptionSettings {
  generation: "manual" | "automatic";
  model: TranscriptionModel;
}

export interface DesktopAppState {
  version: 1;
  recentProjects: RecentProject[];
  mediaPoolOpenByProject: Record<string, boolean>;
  inspectorOpenByProject: Record<string, boolean>;
  notesOpenByProject: Record<string, boolean>;
  editorLayoutsByProject: Record<string, EditorLayoutState>;
  cutLayoutsByProject: Record<string, CutLayoutState>;
  transcriptionSettings: TranscriptionSettings;
}

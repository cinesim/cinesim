import { timeUs } from "@cinesim/core";
import type { ClipId, Sequence } from "@cinesim/core";
import {
  DEFAULT_CUT_LAYOUT,
  DEFAULT_EDITOR_LAYOUT,
  DEFAULT_TRANSCRIPTION_SETTINGS,
} from "../../shared/api";
import type {
  AccountSnapshot,
  CutLayoutState,
  DesktopAppState,
  DesktopProjectSession,
  EditorLayoutState,
} from "../../shared/api";
import type { ProjectLifecycle, RendererState } from "./renderer-state";

export const EMPTY_APP_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  mediaPoolOpenByProject: {},
  inspectorOpenByProject: {},
  notesOpenByProject: {},
  editorLayoutsByProject: {},
  cutLayoutsByProject: {},
  transcriptionSettings: DEFAULT_TRANSCRIPTION_SETTINGS,
};

export const INITIAL_ACCOUNT_STATE: AccountSnapshot = {
  status: "signed-out",
  cloudOrigin: null,
  serviceAvailable: false,
  googleSignIn: false,
  cloudStorage: false,
  transcription: false,
  user: null,
  detail: null,
};

export function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function sessionFromLifecycle(project: ProjectLifecycle): DesktopProjectSession | null {
  if (project.status === "ready") return project.session;
  if (project.status === "opening" || project.status === "failed") return project.previousSession;
  return null;
}

export function activeSequenceFromState(state: RendererState): Sequence | null {
  const session = sessionFromLifecycle(state.project);
  if (!session) return null;
  return (
    session.project.sequences.find((sequence) => sequence.id === state.activeSequenceId) ??
    session.project.sequences.find(
      (sequence) => sequence.id === session.project.activeSequenceId,
    ) ??
    null
  );
}

export function editorLayoutFromState(state: RendererState): EditorLayoutState {
  const session = sessionFromLifecycle(state.project);
  return session
    ? (state.appState.editorLayoutsByProject[session.directory] ?? DEFAULT_EDITOR_LAYOUT)
    : DEFAULT_EDITOR_LAYOUT;
}

export function cutLayoutFromState(state: RendererState): CutLayoutState {
  const session = sessionFromLifecycle(state.project);
  return session
    ? (state.appState.cutLayoutsByProject[session.directory] ?? DEFAULT_CUT_LAYOUT)
    : DEFAULT_CUT_LAYOUT;
}

export function clipExists(sequence: Sequence | null, clipId: ClipId | null): boolean {
  return Boolean(
    sequence &&
    clipId &&
    sequence.tracks.some((track) => track.clips.some((clip) => clip.id === clipId)),
  );
}

export function hydratedProjectState(
  session: DesktopProjectSession,
  appState: DesktopAppState,
): Partial<RendererState> {
  return {
    project: { status: "ready", session },
    appState,
    destination: "project",
    projectSection: "media",
    activeSequenceId: session.project.activeSequenceId,
    mediaPoolOpen: appState.mediaPoolOpenByProject[session.directory] ?? true,
    inspectorOpen: appState.inspectorOpenByProject[session.directory] ?? true,
    notesOpen: appState.notesOpenByProject[session.directory] ?? true,
    operationError: null,
    selectedClipId: null,
    timelineDragging: false,
    playheadUs: timeUs(0),
    playbackRuntime: null,
    derivedMedia: null,
    transcripts: null,
  };
}

export function appStateWithRememberedProject(
  appState: DesktopAppState,
  session: DesktopProjectSession,
): DesktopAppState {
  const remembered: DesktopAppState["recentProjects"][number] = {
    name: session.project.name,
    directory: session.directory,
    kind: session.project.cloudProjectId ? "cloud" : "local",
  };
  return {
    ...appState,
    recentProjects: [
      remembered,
      ...appState.recentProjects.filter((project) => project.directory !== session.directory),
    ].slice(0, 12),
  };
}

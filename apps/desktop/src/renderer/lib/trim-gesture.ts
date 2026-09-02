import type { Clip, EditorCommand, TimeUs } from "@cinesim/core";
import { clipEndUs, timeUs } from "@cinesim/core";
import { snapTimelineTime } from "./timeline-geometry";

export type TrimGestureState =
  | { status: "idle" }
  | {
      status: "trimming";
      pointerId: number;
      edge: "start" | "end";
      originX: number;
      pixelsPerUs: number;
      frameRate?: number;
      snapCandidatesUs: readonly TimeUs[];
      snapToleranceUs: TimeUs;
      clip: Clip;
      splitComponent?: "audio" | "video";
      assetDurationUs?: TimeUs;
      previewAtUs: TimeUs;
    };

export type TrimGestureEvent =
  | {
      type: "start";
      pointerId: number;
      edge: "start" | "end";
      clientX: number;
      pixelsPerUs: number;
      frameRate?: number;
      snapCandidatesUs?: readonly TimeUs[];
      snapToleranceUs?: TimeUs;
      clip: Clip;
      splitComponent?: "audio" | "video";
      assetDurationUs?: TimeUs;
    }
  | { type: "move"; pointerId: number; clientX: number }
  | { type: "finish"; pointerId: number; clientX: number }
  | { type: "cancel"; pointerId: number };

export interface TrimGestureTransition {
  state: TrimGestureState;
  command?: EditorCommand;
}

export const IDLE_TRIM_GESTURE: TrimGestureState = { status: "idle" };

type TrimStartEvent = Extract<TrimGestureEvent, { type: "start" }>;
type ActiveTrimEvent = Exclude<TrimGestureEvent, { type: "start" }>;
type TrimmingState = Extract<TrimGestureState, { status: "trimming" }>;

function startTransition(state: TrimGestureState, event: TrimStartEvent): TrimGestureTransition {
  if (state.status !== "idle" || event.pixelsPerUs <= 0) return { state };
  return {
    state: {
      status: "trimming",
      pointerId: event.pointerId,
      edge: event.edge,
      originX: event.clientX,
      pixelsPerUs: event.pixelsPerUs,
      ...(event.frameRate === undefined ? {} : { frameRate: event.frameRate }),
      snapCandidatesUs: event.snapCandidatesUs ?? [],
      snapToleranceUs: event.snapToleranceUs ?? timeUs(0),
      clip: event.clip,
      ...(event.splitComponent === undefined
        ? {}
        : { splitComponent: event.splitComponent, assetDurationUs: event.assetDurationUs }),
      previewAtUs: event.edge === "start" ? event.clip.timelineStartUs : clipEndUs(event.clip),
    },
  };
}

function trimBounds(state: TrimmingState): { minimumUs: number; maximumUs: number } {
  const clipStartUs = state.clip.timelineStartUs;
  const clipEnd = clipEndUs(state.clip);
  if (state.splitComponent === undefined) {
    return state.edge === "start"
      ? { minimumUs: clipStartUs, maximumUs: clipEnd - 1 }
      : { minimumUs: clipStartUs + 1, maximumUs: clipEnd };
  }
  const playbackRate = state.clip.playbackRate ?? 1;
  const sourceDurationUs = state.assetDurationUs ?? state.clip.sourceEndUs;
  return state.edge === "start"
    ? {
        minimumUs: Math.max(0, clipStartUs - Math.floor(state.clip.sourceStartUs / playbackRate)),
        maximumUs: clipEnd - 1,
      }
    : {
        minimumUs: clipStartUs + 1,
        maximumUs:
          clipStartUs + Math.floor((sourceDurationUs - state.clip.sourceStartUs) / playbackRate),
      };
}

function trimTime(state: TrimmingState, clientX: number): TimeUs {
  const deltaUs = Math.round((clientX - state.originX) / state.pixelsPerUs);
  const clipStartUs = state.clip.timelineStartUs;
  const clipEnd = clipEndUs(state.clip);
  const rawAtUs = timeUs(
    Math.max(0, state.edge === "start" ? clipStartUs + deltaUs : clipEnd + deltaUs),
  );
  const proposedAtUs = state.frameRate
    ? snapTimelineTime(rawAtUs, state.frameRate, state.snapCandidatesUs, state.snapToleranceUs)
        .timeUs
    : rawAtUs;
  const bounds = trimBounds(state);
  return timeUs(Math.min(bounds.maximumUs, Math.max(bounds.minimumUs, proposedAtUs)));
}

function finishTransition(state: TrimmingState, atUs: TimeUs): TrimGestureTransition {
  const unchanged =
    state.edge === "start" ? atUs === state.clip.timelineStartUs : atUs === clipEndUs(state.clip);
  if (unchanged) return { state: IDLE_TRIM_GESTURE };
  return {
    state: IDLE_TRIM_GESTURE,
    command:
      state.splitComponent === undefined
        ? {
            type: state.edge === "start" ? "clip.trimStart" : "clip.trimEnd",
            clipId: state.clip.id,
            atUs,
          }
        : {
            type: "clip.splitEdit",
            clipId: state.clip.id,
            component: state.splitComponent,
            edge: state.edge,
            atUs,
          },
  };
}

function activeTransition(state: TrimmingState, event: ActiveTrimEvent): TrimGestureTransition {
  if (state.pointerId !== event.pointerId) return { state };
  if (event.type === "cancel") return { state: IDLE_TRIM_GESTURE };
  const atUs = trimTime(state, event.clientX);
  return event.type === "move"
    ? { state: { ...state, previewAtUs: atUs } }
    : finishTransition(state, atUs);
}

export function transitionTrimGesture(
  state: TrimGestureState,
  event: TrimGestureEvent,
): TrimGestureTransition {
  if (event.type === "start") return startTransition(state, event);
  return state.status === "trimming" ? activeTransition(state, event) : { state };
}

export function trimPreviewRange(
  state: TrimGestureState,
): { timelineStartUs: TimeUs; timelineEndUs: TimeUs } | null {
  if (state.status !== "trimming") return null;
  return state.edge === "start"
    ? { timelineStartUs: state.previewAtUs, timelineEndUs: clipEndUs(state.clip) }
    : { timelineStartUs: state.clip.timelineStartUs, timelineEndUs: state.previewAtUs };
}

export function trimPreviewClip(state: TrimGestureState): Clip | null {
  if (state.status !== "trimming") return null;
  if (state.edge === "start") {
    return {
      ...state.clip,
      timelineStartUs: state.previewAtUs,
      sourceStartUs: timeUs(
        state.clip.sourceStartUs + state.previewAtUs - state.clip.timelineStartUs,
      ),
    };
  }
  return {
    ...state.clip,
    sourceEndUs: timeUs(state.clip.sourceStartUs + state.previewAtUs - state.clip.timelineStartUs),
  };
}

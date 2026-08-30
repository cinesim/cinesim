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
    }
  | { type: "move"; pointerId: number; clientX: number }
  | { type: "finish"; pointerId: number; clientX: number }
  | { type: "cancel"; pointerId: number };

export interface TrimGestureTransition {
  state: TrimGestureState;
  command?: EditorCommand;
}

export const IDLE_TRIM_GESTURE: TrimGestureState = { status: "idle" };

export function transitionTrimGesture(
  state: TrimGestureState,
  event: TrimGestureEvent,
): TrimGestureTransition {
  if (event.type === "start") {
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
        previewAtUs: event.edge === "start" ? event.clip.timelineStartUs : clipEndUs(event.clip),
      },
    };
  }
  if (state.status !== "trimming" || state.pointerId !== event.pointerId) return { state };
  if (event.type === "cancel") return { state: IDLE_TRIM_GESTURE };
  const deltaUs = Math.round((event.clientX - state.originX) / state.pixelsPerUs);
  const clipStartUs = state.clip.timelineStartUs;
  const clipEnd = clipEndUs(state.clip);
  const rawAtUs = timeUs(
    Math.max(0, state.edge === "start" ? clipStartUs + deltaUs : clipEnd + deltaUs),
  );
  const proposedAtUs = state.frameRate
    ? snapTimelineTime(rawAtUs, state.frameRate, state.snapCandidatesUs, state.snapToleranceUs)
        .timeUs
    : rawAtUs;
  const atUs =
    state.edge === "start"
      ? timeUs(Math.min(clipEnd - 1, Math.max(clipStartUs, proposedAtUs)))
      : timeUs(Math.max(clipStartUs + 1, Math.min(clipEnd, proposedAtUs)));
  if (event.type === "move") return { state: { ...state, previewAtUs: atUs } };
  const unchanged = state.edge === "start" ? atUs === clipStartUs : atUs === clipEnd;
  if (unchanged) return { state: IDLE_TRIM_GESTURE };
  return {
    state: IDLE_TRIM_GESTURE,
    command: {
      type: state.edge === "start" ? "clip.trimStart" : "clip.trimEnd",
      clipId: state.clip.id,
      atUs,
    },
  };
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

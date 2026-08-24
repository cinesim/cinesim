import type { Clip, EditorCommand } from "@cinesim/core";
import { clipEndUs } from "@cinesim/core";

export type TrimGestureState =
  | { status: "idle" }
  | {
      status: "trimming";
      pointerId: number;
      edge: "start" | "end";
      originX: number;
      pixelsPerUs: number;
      clip: Clip;
    };

export type TrimGestureEvent =
  | {
      type: "start";
      pointerId: number;
      edge: "start" | "end";
      clientX: number;
      pixelsPerUs: number;
      clip: Clip;
    }
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
        clip: event.clip,
      },
    };
  }
  if (state.status !== "trimming" || state.pointerId !== event.pointerId) return { state };
  if (event.type === "cancel") return { state: IDLE_TRIM_GESTURE };
  const deltaUs = Math.round((event.clientX - state.originX) / state.pixelsPerUs);
  const clipStartUs = state.clip.timelineStartUs;
  const clipEnd = clipEndUs(state.clip);
  const atUs =
    state.edge === "start"
      ? Math.min(clipEnd - 1, Math.max(clipStartUs, clipStartUs + deltaUs))
      : Math.max(clipStartUs + 1, Math.min(clipEnd, clipEnd + deltaUs));
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

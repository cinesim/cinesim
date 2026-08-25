import { describe, expect, it } from "vitest";
import { DEFAULT_TRANSFORM, type Clip } from "@cinesim/core";
import {
  IDLE_TRIM_GESTURE,
  trimPreviewClip,
  trimPreviewRange,
  transitionTrimGesture,
} from "../src/renderer/interactions/trim-gesture";

const clip: Clip = {
  id: "clip_fixture",
  assetId: "asset_fixture",
  mediaKind: "video",
  timelineStartUs: 2_000_000,
  sourceStartUs: 1_000_000,
  sourceEndUs: 5_000_000,
  transform: DEFAULT_TRANSFORM,
};

describe("timeline trim gesture", () => {
  it("produces exactly one canonical command when the gesture commits", () => {
    const started = transitionTrimGesture(IDLE_TRIM_GESTURE, {
      type: "start",
      pointerId: 7,
      edge: "end",
      clientX: 100,
      pixelsPerUs: 0.0001,
      clip,
    });
    expect(started.command).toBeUndefined();

    const finished = transitionTrimGesture(started.state, {
      type: "finish",
      pointerId: 7,
      clientX: 80,
    });

    expect(finished.state).toBe(IDLE_TRIM_GESTURE);
    expect(finished.command).toEqual({
      type: "clip.trimEnd",
      clipId: clip.id,
      atUs: 5_800_000,
    });
  });

  it("tracks transient geometry without producing canonical commands", () => {
    const started = transitionTrimGesture(IDLE_TRIM_GESTURE, {
      type: "start",
      pointerId: 8,
      edge: "start",
      clientX: 100,
      pixelsPerUs: 0.0001,
      clip,
    });
    const moved = transitionTrimGesture(started.state, {
      type: "move",
      pointerId: 8,
      clientX: 150,
    });
    expect(moved.command).toBeUndefined();
    expect(trimPreviewRange(moved.state)).toEqual({
      timelineStartUs: 2_500_000,
      timelineEndUs: 6_000_000,
    });
    expect(trimPreviewClip(moved.state)).toMatchObject({
      timelineStartUs: 2_500_000,
      sourceStartUs: 1_500_000,
      sourceEndUs: 5_000_000,
    });
  });

  it("quantizes trim points to frames and optional nearby edit points", () => {
    const started = transitionTrimGesture(IDLE_TRIM_GESTURE, {
      type: "start",
      pointerId: 9,
      edge: "end",
      clientX: 100,
      pixelsPerUs: 0.0001,
      frameRate: 30,
      snapCandidatesUs: [5_755_000],
      snapToleranceUs: 15_000,
      clip,
    });
    const frameQuantized = transitionTrimGesture(started.state, {
      type: "move",
      pointerId: 9,
      clientX: 73,
    });
    expect(trimPreviewRange(frameQuantized.state)?.timelineEndUs).toBe(5_733_333);

    const snapped = transitionTrimGesture(started.state, {
      type: "move",
      pointerId: 9,
      clientX: 75,
    });
    expect(trimPreviewRange(snapped.state)?.timelineEndUs).toBe(5_755_000);
    expect(trimPreviewClip(snapped.state)?.sourceEndUs).toBe(4_755_000);
  });

  it("does not persist a command when pointer capture is cancelled or belongs to another pointer", () => {
    const started = transitionTrimGesture(IDLE_TRIM_GESTURE, {
      type: "start",
      pointerId: 4,
      edge: "start",
      clientX: 100,
      pixelsPerUs: 0.0001,
      clip,
    });
    const unrelated = transitionTrimGesture(started.state, {
      type: "finish",
      pointerId: 5,
      clientX: 120,
    });
    expect(unrelated).toEqual({ state: started.state });

    const cancelled = transitionTrimGesture(unrelated.state, { type: "cancel", pointerId: 4 });
    expect(cancelled).toEqual({ state: IDLE_TRIM_GESTURE });
  });

  it("does not create no-op or outward trim commands", () => {
    const started = transitionTrimGesture(IDLE_TRIM_GESTURE, {
      type: "start",
      pointerId: 1,
      edge: "start",
      clientX: 100,
      pixelsPerUs: 0.0001,
      clip,
    });

    expect(
      transitionTrimGesture(started.state, {
        type: "finish",
        pointerId: 1,
        clientX: 80,
      }),
    ).toEqual({ state: IDLE_TRIM_GESTURE });
  });
});

import { describe, expect, it } from "vite-plus/test";
import type { Asset } from "@cinesim/core";
import type { IrProgram, IrTransform } from "@cinesim/ir";
import {
  beginTransformGesture,
  transformGestureUpdates,
  updateTransformGesture,
  viewerTransformBox,
} from "../src/renderer/components/viewer/viewer-transform-geometry";
import {
  programWithClipTransform,
  selectedVisualClip,
} from "../src/renderer/components/viewer/viewer-transform-program";

const transform: IrTransform = {
  x: 0,
  y: 0,
  anchorX: 50,
  anchorY: 50,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  fit: "contain",
  cornerRadius: 0,
  blendMode: "normal",
};

const composition = { width: 1920, height: 1080 };
const display = { width: 960, height: 540 };

describe("viewer transform controls", () => {
  it("positions pixel transforms and preserves contained media bounds", () => {
    const verticalAsset = { width: 1080, height: 1920 } as Asset;
    const box = viewerTransformBox(
      { ...transform, x: 192, y: 108 },
      composition,
      display,
      verticalAsset,
    );

    expect(box.centerX).toBe(576);
    expect(box.centerY).toBe(324);
    expect(box.width).toBeCloseTo(303.75);
    expect(box.height).toBe(540);
  });

  it("moves in composition pixels regardless of viewer zoom", () => {
    const gesture = beginTransformGesture(
      "move",
      transform,
      { x: 100, y: 100 },
      { x: 480, y: 270 },
      composition,
      display,
    );

    expect(updateTransformGesture(gesture, { x: 196, y: 154 })).toMatchObject({
      x: 192,
      y: 108,
    });
  });

  it("scales proportionally and rotates around the selected clip center", () => {
    const scale = beginTransformGesture(
      "scale",
      transform,
      { x: 580, y: 270 },
      { x: 480, y: 270 },
      composition,
      display,
    );
    expect(updateTransformGesture(scale, { x: 680, y: 270 })).toMatchObject({
      scaleX: 2,
      scaleY: 2,
    });

    const rotate = beginTransformGesture(
      "rotate",
      transform,
      { x: 480, y: 170 },
      { x: 480, y: 270 },
      composition,
      display,
    );
    expect(updateTransformGesture(rotate, { x: 580, y: 270 }).rotation).toBe(90);
  });

  it("maps each gesture to one atomic property batch", () => {
    expect(transformGestureUpdates("move", { ...transform, x: 10, y: 20 })).toEqual([
      { property: "x", value: { kind: "length", unit: "px", value: 10 } },
      { property: "y", value: { kind: "length", unit: "px", value: 20 } },
    ]);
    expect(transformGestureUpdates("scale", { ...transform, scaleX: 0.5, scaleY: 0.5 })).toEqual([
      { property: "scaleX", value: { kind: "number", value: 0.5 } },
      { property: "scaleY", value: { kind: "number", value: 0.5 } },
    ]);
  });

  it("patches only the optimistic clip and limits handles to active visual clips", () => {
    const program = {
      activeCompositionId: "sequence_main",
      compositions: [
        {
          id: "sequence_main",
          width: 1920,
          height: 1080,
          timeline: {
            tracks: [
              {
                kind: "video",
                muted: false,
                clips: [
                  {
                    id: "clip_one",
                    enabled: true,
                    timelineStartUs: 0,
                    durationUs: 1_000_000,
                    transform,
                  },
                ],
              },
            ],
          },
        },
      ],
    } as IrProgram;

    expect(selectedVisualClip(program, "sequence_main", "clip_one", 500_000)?.clip.id).toBe(
      "clip_one",
    );
    expect(selectedVisualClip(program, "sequence_main", "clip_one", 1_000_000)).toBeNull();
    const optimistic = programWithClipTransform(program, "clip_one", {
      ...transform,
      rotation: 25,
    });
    expect(optimistic.compositions[0]!.timeline.tracks[0]!.clips[0]!.transform.rotation).toBe(25);
    expect(program.compositions[0]!.timeline.tracks[0]!.clips[0]!.transform.rotation).toBe(0);
  });
});

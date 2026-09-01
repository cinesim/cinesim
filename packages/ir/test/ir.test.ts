import { describe, expect, it } from "vite-plus/test";
import {
  createAudioPlan,
  createRenderPlan,
  evaluateIrFrame,
  irTimeUs,
  projectTimeline,
  serializeIr,
  validateIrProgram,
  type IrProgram,
  type IrSceneNode,
} from "@cinesim/ir";

const scene: IrSceneNode = {
  id: "title",
  kind: "text",
  props: { opacity: { kind: "number", value: 0 } },
  animations: [
    {
      property: "opacity",
      keyframes: [
        { at: irTimeUs(0), value: { kind: "number", value: 0 }, easing: "linear" },
        { at: irTimeUs(1_000_000), value: { kind: "number", value: 1 }, easing: "linear" },
      ],
    },
  ],
  effects: [],
  children: [],
};

function program(): IrProgram {
  const transform = {
    x: 0,
    y: 0,
    anchorX: 50,
    anchorY: 50,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    zIndex: 0,
    fit: "contain" as const,
    cornerRadius: 0,
    blendMode: "normal",
  };
  return {
    version: 2,
    languageVersion: 1,
    projectId: "project_test",
    activeCompositionId: "sequence_main",
    referencedAssetIds: ["asset_camera"],
    compositions: [
      {
        id: "sequence_main",
        name: "Main",
        width: 1920,
        height: 1080,
        frameRate: 30,
        background: "#000000",
        timeline: {
          id: "timeline_main",
          notes: [],
          markers: [],
          transitions: [],
          tracks: [
            {
              id: "track_video",
              kind: "video",
              name: "Video",
              muted: false,
              locked: false,
              effects: [],
              clips: [
                {
                  id: "clip_camera",
                  trackId: "track_video",
                  assetId: "asset_camera",
                  mediaKind: "video",
                  timelineStartUs: irTimeUs(0),
                  sourceStartUs: irTimeUs(2_000_000),
                  durationUs: irTimeUs(3_000_000),
                  playbackRate: 1,
                  enabled: true,
                  reverse: false,
                  freeze: false,
                  loop: false,
                  fades: { inUs: irTimeUs(500_000), outUs: irTimeUs(500_000) },
                  transform,
                  audio: { gainDb: 0, pan: 0, muted: false },
                  content: scene,
                  effects: [],
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

describe("semantic ir", () => {
  it("serializes object keys deterministically without changing semantic array order", () => {
    expect(serializeIr({ z: 1, a: { d: 2, b: 1 }, order: ["z", "a"] })).toBe(
      '{\n  "a": {\n    "b": 1,\n    "d": 2\n  },\n  "order": [\n    "z",\n    "a"\n  ],\n  "z": 1\n}\n',
    );
  });

  it("evaluates typed keyframes and produces timeline/render/audio projections", () => {
    const ir = program();
    validateIrProgram(ir, new Set(["asset_camera"]));
    expect(evaluateIrFrame(scene, 500_000).props.opacity).toEqual({ kind: "number", value: 0.5 });
    expect(projectTimeline(ir).durationUs).toBe(3_000_000);
    expect(createRenderPlan(ir, 250_000).layers[0]).toMatchObject({
      clipId: "clip_camera",
      sourceTimeUs: 2_250_000,
      opacity: 0.5,
    });
    expect(createAudioPlan(ir, 250_000).sources).toEqual([]);
  });

  it("rejects invalid links and asset catalogs", () => {
    const ir = program();
    ir.compositions[0]!.timeline.tracks[0]!.clips[0]!.linkedClipId = "clip_missing";
    expect(() => validateIrProgram(ir, new Set(["asset_camera"]))).toThrow(/reciprocal/);
  });
});

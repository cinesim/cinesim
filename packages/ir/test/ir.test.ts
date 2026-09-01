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
          captionTracks: [],
          notes: [],
          markers: [],
          transitions: [],
          audioTransitions: [],
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

  it("targets active time-bounded adjustment layers below their owner", () => {
    const ir = program();
    ir.compositions[0]!.timeline.tracks.unshift({
      id: "track_adjustments",
      kind: "overlay",
      name: "Adjustments",
      muted: false,
      locked: false,
      clips: [],
      effects: [],
      adjustments: [
        {
          id: "adjustment_grade",
          trackId: "track_adjustments",
          timelineStartUs: irTimeUs(100_000),
          durationUs: irTimeUs(500_000),
          scope: "below",
          depth: 1,
          targetTrackIds: [],
          enabled: true,
          animations: [],
          effects: [
            {
              id: "adjustment_grade/color",
              kind: "colorgrade",
              enabled: true,
              props: { exposure: { kind: "number", value: 0.5 } },
              animations: [
                {
                  property: "exposure",
                  keyframes: [
                    { at: irTimeUs(0), value: { kind: "number", value: 0 }, easing: "linear" },
                    {
                      at: irTimeUs(300_000),
                      value: { kind: "number", value: 1 },
                      easing: "linear",
                    },
                  ],
                },
              ],
              children: [],
            },
          ],
        },
      ],
    });
    validateIrProgram(ir, new Set(["asset_camera"]));
    expect(createRenderPlan(ir, 50_000).adjustments).toEqual([]);
    const plan = createRenderPlan(ir, 250_000);
    expect(plan.adjustments[0]).toMatchObject({
      id: "adjustment_grade",
      targetTrackIds: ["track_video"],
    });
    expect(plan.layers[0]!.effects).toEqual([]);
    expect(plan.adjustments[0]!.effects[0]!.props.exposure).toEqual({
      kind: "number",
      value: 0.5,
    });
    expect(projectTimeline(ir).tracks[0]!.adjustments[0]?.id).toBe("adjustment_grade");
    ir.compositions[0]!.timeline.tracks[0]!.adjustments!.push({
      id: "adjustment_conflict",
      trackId: "track_adjustments",
      timelineStartUs: irTimeUs(200_000),
      durationUs: irTimeUs(100_000),
      scope: "tracks",
      depth: 1,
      targetTrackIds: ["track_video"],
      enabled: true,
      animations: [],
      effects: [],
    });
    expect(() => validateIrProgram(ir, new Set(["asset_camera"]))).toThrow(
      /overlap the same target/,
    );
  });

  it("projects active caption cues with cue-local typed animation", () => {
    const ir = program();
    ir.compositions[0]!.timeline.captionTracks.push({
      id: "captions_en",
      name: "English",
      transcriptFingerprint: "sha256:fixture",
      props: { fill: { kind: "color", value: "#ffffff" } },
      cues: [
        {
          id: "cue_intro",
          startUs: irTimeUs(1_000_000),
          durationUs: irTimeUs(2_000_000),
          text: "Welcome home",
          props: { scale: { kind: "number", value: 0.9 } },
          animations: [
            {
              property: "scale",
              keyframes: [
                { at: irTimeUs(0), value: { kind: "number", value: 0.9 }, easing: "linear" },
                { at: irTimeUs(1_000_000), value: { kind: "number", value: 1 }, easing: "linear" },
              ],
            },
          ],
          words: [],
        },
      ],
    });

    validateIrProgram(ir, new Set(["asset_camera"]));
    expect(projectTimeline(ir).durationUs).toBe(3_000_000);
    expect(createRenderPlan(ir, 1_500_000).captions).toMatchObject([
      { cue: { id: "cue_intro" }, props: { scale: { kind: "number", value: 0.95 } } },
    ]);
    expect(createRenderPlan(ir, 3_000_000).captions).toEqual([]);
  });

  it("rejects invalid links and asset catalogs", () => {
    const ir = program();
    ir.compositions[0]!.timeline.tracks[0]!.clips[0]!.linkedClipId = "clip_missing";
    expect(() => validateIrProgram(ir, new Set(["asset_camera"]))).toThrow(/reciprocal/);
  });

  it("preserves reciprocal A/V links when split-edit ranges differ", () => {
    const ir = program();
    const video = ir.compositions[0]!.timeline.tracks[0]!.clips[0]!;
    const { content: _content, ...audioFields } = structuredClone(video);
    video.linkedClipId = "clip_audio";
    ir.compositions[0]!.timeline.tracks.push({
      id: "track_audio",
      kind: "audio",
      name: "Audio",
      muted: false,
      locked: false,
      effects: [],
      clips: [
        {
          ...audioFields,
          id: "clip_audio",
          trackId: "track_audio",
          mediaKind: "audio",
          linkedClipId: video.id,
          timelineStartUs: irTimeUs(1_000_000),
          sourceStartUs: irTimeUs(1_000_000),
          durationUs: irTimeUs(4_000_000),
        },
      ],
    });

    expect(() => validateIrProgram(ir, new Set(["asset_camera"]))).not.toThrow();
  });
});

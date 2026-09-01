import { describe, expect, it } from "vite-plus/test";
import {
  createAudioPlan,
  createRenderPlan,
  irTimeUs,
  validateIrProgram,
  type IrClip,
  type IrProgram,
  type IrTrack,
  type IrTransition,
} from "../src";

function clip(
  id: string,
  trackId: string,
  assetId: string,
  startUs: number,
  sourceStartUs: number,
): IrClip {
  return {
    id,
    trackId,
    assetId,
    mediaKind: trackId === "track_audio" ? "audio" : "video",
    timelineStartUs: irTimeUs(startUs),
    sourceStartUs: irTimeUs(sourceStartUs),
    durationUs: irTimeUs(2_000_000),
    playbackRate: 1,
    enabled: true,
    reverse: false,
    freeze: false,
    loop: false,
    fades: { inUs: irTimeUs(0), outUs: irTimeUs(0) },
    transform: {
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
    },
    audio: { gainDb: 0, pan: 0, muted: false },
    effects: [],
  };
}

function track(id: string, kind: IrTrack["kind"], clips: IrClip[]): IrTrack {
  return { id, kind, name: id, muted: false, locked: false, clips, effects: [] };
}

function transition(kind: IrTransition["kind"]): IrTransition {
  return {
    id: "transition_picture",
    fromClipId: "clip_from",
    toClipId: "clip_to",
    kind,
    durationUs: irTimeUs(1_000_000),
    easing: "linear",
    props: {
      direction: { kind: "string", value: "left" },
      color: { kind: "color", value: "#101010" },
      softness: { kind: "percent", value: 2 },
      intensity: { kind: "number", value: 1 },
    },
  };
}

function program(kind: IrTransition["kind"] = "dissolve"): IrProgram {
  const visual = track("track_video", "video", [
    clip("clip_from", "track_video", "asset_from", 0, 0),
    clip("clip_to", "track_video", "asset_to", 2_000_000, 1_000_000),
  ]);
  const audio = track("track_audio", "audio", [
    clip("clip_audio_from", "track_audio", "asset_audio_from", 0, 0),
    clip("clip_audio_to", "track_audio", "asset_audio_to", 2_000_000, 1_000_000),
  ]);
  return {
    version: 2,
    languageVersion: 1,
    projectId: "project_transition",
    activeCompositionId: "sequence_main",
    referencedAssetIds: ["asset_audio_from", "asset_audio_to", "asset_from", "asset_to"],
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
          tracks: [visual, audio],
          captionTracks: [],
          notes: [],
          markers: [],
          transitions: [transition(kind)],
          audioTransitions: [
            {
              id: "transition_audio",
              fromClipId: "clip_audio_from",
              toClipId: "clip_audio_to",
              durationUs: irTimeUs(1_000_000),
              easing: "linear",
              curve: "equal-power",
            },
          ],
        },
      },
    ],
  };
}

describe("edit-point transitions", () => {
  it("validates adjacency and incoming source handles", () => {
    const valid = program();
    expect(() => validateIrProgram(valid, new Set(valid.referencedAssetIds))).not.toThrow();
    const invalid = program();
    invalid.compositions[0]!.timeline.tracks[0]!.clips[1]!.sourceStartUs = irTimeUs(500_000);
    expect(() => validateIrProgram(invalid, new Set(invalid.referencedAssetIds))).toThrow(
      /source handles/u,
    );
  });

  it("plans two decoded sources with easing and exact pre-roll over a dissolve", () => {
    const plan = createRenderPlan(program(), 1_500_000);
    expect(plan.transitions).toEqual([
      expect.objectContaining({ kind: "dissolve", startUs: 1_000_000, progress: 0.5 }),
    ]);
    expect(plan.layers).toEqual([
      expect.objectContaining({ clipId: "clip_from", sourceTimeUs: 1_500_000, opacity: 0.5 }),
      expect.objectContaining({ clipId: "clip_to", sourceTimeUs: 500_000, opacity: 0.5 }),
    ]);
  });

  it.each(["dip", "wipe", "slide", "push", "zoom", "blur"] as const)(
    "plans executable %s transition parameters",
    (kind) => {
      const plan = createRenderPlan(program(kind), 1_500_000);
      expect(plan.layers).toHaveLength(2);
      expect(plan.layers[1]?.transition).toMatchObject({ kind, role: "to", progress: 0.5 });
      if (kind === "slide" || kind === "push") expect(plan.layers[1]?.transform.x).toBe(960);
      if (kind === "zoom") expect(plan.layers[1]?.transform.scaleX).toBeCloseTo(0.925);
    },
  );

  it("plans an independent equal-power audio crossfade", () => {
    const plan = createAudioPlan(program(), 1_500_000);
    expect(plan.sources.filter(({ trackId }) => trackId === "track_audio")).toEqual([
      expect.objectContaining({ clipId: "clip_audio_from", gain: expect.closeTo(Math.SQRT1_2, 5) }),
      expect.objectContaining({
        clipId: "clip_audio_to",
        sourceTimeUs: 500_000,
        gain: expect.closeTo(Math.SQRT1_2, 5),
      }),
    ]);
  });
});

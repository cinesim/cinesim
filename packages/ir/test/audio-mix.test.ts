import { describe, expect, it } from "vite-plus/test";
import {
  audioDuckAutomation,
  audioDuckGainAt,
  createAudioPlan,
  irTimeUs,
  validateIrProgram,
  type IrClip,
  type IrComposition,
  type IrProgram,
  type IrTrack,
} from "../src";

function audioClip(
  id: string,
  trackId: string,
  assetId: string,
  startUs: number,
  durationUs: number,
): IrClip {
  return {
    id,
    trackId,
    assetId,
    mediaKind: "audio",
    timelineStartUs: irTimeUs(startUs),
    sourceStartUs: irTimeUs(0),
    durationUs: irTimeUs(durationUs),
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

function fixture(): {
  program: IrProgram;
  composition: IrComposition;
  music: IrTrack;
  clip: IrClip;
} {
  const clip = audioClip("clip_music", "track_music", "asset_music", 0, 10_000_000);
  const music: IrTrack = {
    id: "track_music",
    kind: "audio",
    name: "Music",
    muted: false,
    locked: false,
    clips: [clip],
    effects: [
      {
        id: "duck_music",
        kind: "ducker",
        enabled: true,
        props: {
          sidechain: { kind: "string", value: "track_dialogue" },
          reduction: { kind: "decibels", value: -12 },
          attack: { kind: "time", valueUs: irTimeUs(1_000_000) },
          release: { kind: "time", valueUs: irTimeUs(2_000_000) },
        },
        children: [],
      },
    ],
  };
  const dialogue: IrTrack = {
    id: "track_dialogue",
    kind: "audio",
    name: "Dialogue",
    muted: false,
    locked: false,
    clips: [audioClip("clip_dialogue", "track_dialogue", "asset_dialogue", 4_000_000, 2_000_000)],
    effects: [],
  };
  const composition: IrComposition = {
    id: "composition_main",
    name: "Main",
    width: 1920,
    height: 1080,
    frameRate: 30,
    background: "#000000",
    timeline: {
      id: "timeline_main",
      tracks: [music, dialogue],
      captionTracks: [],
      notes: [],
      markers: [],
      transitions: [],
      audioTransitions: [],
    },
  };
  return {
    program: {
      version: 2,
      languageVersion: 1,
      projectId: "project_fixture",
      activeCompositionId: composition.id,
      compositions: [composition],
      referencedAssetIds: ["asset_dialogue", "asset_music"],
    },
    composition,
    music,
    clip,
  };
}

describe("audio mixing", () => {
  it("creates deterministic look-ahead duck and release automation", () => {
    const { program, composition, music, clip } = fixture();
    validateIrProgram(program, new Set(program.referencedAssetIds));
    const reduced = 10 ** (-12 / 20);

    expect(audioDuckGainAt(composition, music, clip, 3_000_000)).toBe(1);
    expect(audioDuckGainAt(composition, music, clip, 3_500_000)).toBeCloseTo((1 + reduced) / 2);
    expect(audioDuckGainAt(composition, music, clip, 4_000_000)).toBeCloseTo(reduced);
    expect(audioDuckGainAt(composition, music, clip, 7_000_000)).toBeCloseTo((1 + reduced) / 2);
    expect(audioDuckGainAt(composition, music, clip, 8_000_000)).toBe(1);
    expect(audioDuckAutomation(composition, music, clip, 2_000_000, 9_000_000)).toHaveLength(6);
    expect(
      createAudioPlan(program, 4_000_000).sources.find(({ clipId }) => clipId === clip.id)?.gain,
    ).toBeCloseTo(reduced);
  });

  it("rejects self-sidechains", () => {
    const { program, music } = fixture();
    music.effects[0]!.props.sidechain = { kind: "string", value: music.id };
    expect(() => validateIrProgram(program)).toThrow(/different audio sidechain/);
  });
});

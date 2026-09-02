import { expect, describe, it, vi } from "vite-plus/test";
import { timeUs } from "@cinesim/core";
import { irTimeUs, type IrClip, type IrProgram } from "@cinesim/ir";
import type { AudioBufferChunk, AudioSource } from "@cinesim/engine";
import { mixExportAudioChannels } from "../src/renderer/lib/export-audio-mixer";

function clip(): IrClip {
  return {
    id: "clip_audio",
    trackId: "track_audio",
    assetId: "asset_audio",
    mediaKind: "audio",
    timelineStartUs: irTimeUs(0),
    sourceStartUs: irTimeUs(0),
    durationUs: irTimeUs(1_000_000),
    playbackRate: 1,
    enabled: true,
    reverse: false,
    freeze: false,
    loop: false,
    fades: { inUs: irTimeUs(100_000), outUs: irTimeUs(0) },
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

function program(): IrProgram {
  const composition = {
    id: "composition_main",
    name: "Main",
    width: 1920,
    height: 1080,
    frameRate: 30,
    background: "#000000",
    timeline: {
      id: "timeline_main",
      tracks: [
        {
          id: "track_audio",
          kind: "audio" as const,
          name: "Audio",
          muted: false,
          locked: false,
          clips: [clip()],
          effects: [],
        },
      ],
      captionTracks: [],
      notes: [],
      markers: [],
      transitions: [],
      audioTransitions: [],
    },
  };
  return {
    version: 2,
    languageVersion: 1,
    projectId: "project_fixture",
    activeCompositionId: composition.id,
    compositions: [composition],
    referencedAssetIds: ["asset_audio"],
  };
}

function constantChunk(value: number, sampleRate: number): AudioBufferChunk {
  const channels = [
    new Float32Array(sampleRate).fill(value),
    new Float32Array(sampleRate).fill(value),
  ];
  return {
    buffer: {
      length: sampleRate,
      numberOfChannels: 2,
      sampleRate,
      getChannelData: (channel: number) => channels[channel]!,
    } as AudioBuffer,
    timestampUs: timeUs(0),
    durationUs: timeUs(1_000_000),
  };
}

describe("export audio mixer", () => {
  it("decodes only a bounded source window and evaluates timeline fades", async () => {
    const requests: Array<{ fromUs: number; toUs: number }> = [];
    const source = {
      buffers: vi.fn(async function* (fromUs, toUs) {
        requests.push({ fromUs, toUs });
        yield constantChunk(0.25, 1_000);
      }),
    } satisfies AudioSource;

    const [left, right] = await mixExportAudioChannels({
      program: program(),
      fromUs: timeUs(0),
      toUs: timeUs(200_000),
      sampleRate: 1_000,
      source: () => source,
    });

    expect(left).toHaveLength(200);
    expect(right).toHaveLength(200);
    expect(left[0]).toBe(0);
    expect(left[50]).toBeGreaterThan(0.1);
    expect(left[199]).toBeCloseTo(0.25, 4);
    expect(right).toEqual(left);
    expect(requests).toEqual([{ fromUs: 0, toUs: 299_000 }]);
  });
});

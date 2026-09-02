import { timeUs } from "@cinesim/core";
import { irTimeUs } from "@cinesim/ir";
import { describe, expect, it } from "vite-plus/test";
import type { AudioSource } from "../src/media/video-source";
import {
  audioFadeGainAt,
  audioMixGainAt,
  WebAudioScheduler,
} from "../src/playback/audio-scheduler";

class FakeBufferSourceNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly starts: Array<[number, number, number]> = [];
  disconnects = 0;
  stops = 0;

  constructor(private readonly startError?: Error) {}

  connect(): void {}

  disconnect(): void {
    this.disconnects += 1;
  }

  start(when = 0, offset = 0, duration = 0): void {
    if (this.startError) throw this.startError;
    this.starts.push([when, offset, duration]);
  }

  stop(): void {
    if (this.starts.length === 0)
      throw new DOMException("Source has not started", "InvalidStateError");
    this.stops += 1;
  }
}

interface AudioObservations {
  gains: number[];
  pans: number[];
}

function audioContext(
  node: FakeBufferSourceNode,
  observations: AudioObservations = { gains: [], pans: [] },
): AudioContext {
  const createGain = () =>
    ({
      channelCount: 0,
      channelCountMode: "max",
      channelInterpretation: "speakers",
      gain: {
        value: 1,
        setValueAtTime: (value: number) => observations.gains.push(value),
        linearRampToValueAtTime: (value: number) => observations.gains.push(value),
      },
      connect: () => undefined,
      disconnect: () => undefined,
    }) as unknown as GainNode;
  const createAnalyser = () =>
    ({
      fftSize: 32,
      smoothingTimeConstant: 0,
      connect: () => undefined,
      getFloatTimeDomainData: () => undefined,
    }) as unknown as AnalyserNode;
  return {
    currentTime: 10,
    destination: {} as AudioDestinationNode,
    createAnalyser,
    createBufferSource: () => node as unknown as AudioBufferSourceNode,
    createChannelSplitter: () => ({ connect: () => undefined }) as unknown as ChannelSplitterNode,
    createGain,
    createStereoPanner: () =>
      ({
        pan: {
          get value() {
            return observations.pans.at(-1) ?? 0;
          },
          set value(value: number) {
            observations.pans.push(value);
          },
        },
        connect: () => undefined,
        disconnect: () => undefined,
      }) as unknown as StereoPannerNode,
    resume: async () => undefined,
    close: async () => undefined,
  } as unknown as AudioContext;
}

function audioSource(timestampUs: number, durationSeconds = 1): AudioSource {
  return {
    buffers: async function* () {
      yield {
        buffer: { duration: durationSeconds } as AudioBuffer,
        timestampUs: timeUs(timestampUs),
        durationUs: timeUs(Math.round(durationSeconds * 1_000_000)),
      };
    },
  };
}

describe("audio fade envelope", () => {
  const envelope = {
    timelineStartUs: timeUs(1_000_000),
    timelineEndUs: timeUs(11_000_000),
    fadeInUs: timeUs(2_000_000),
    fadeOutUs: timeUs(4_000_000),
  };

  it("returns linear gain through fade in, body, and fade out", () => {
    expect(audioFadeGainAt(envelope, timeUs(1_000_000))).toBe(0);
    expect(audioFadeGainAt(envelope, timeUs(2_000_000))).toBe(0.5);
    expect(audioFadeGainAt(envelope, timeUs(5_000_000))).toBe(1);
    expect(audioFadeGainAt(envelope, timeUs(9_000_000))).toBe(0.5);
    expect(audioFadeGainAt(envelope, timeUs(11_000_000))).toBe(0);
  });

  it("combines base, fade, and interpolated ducking gain", () => {
    expect(
      audioMixGainAt(
        {
          ...envelope,
          gain: 0.5,
          ducking: [
            { timelineUs: irTimeUs(1_000_000), gain: 1 },
            { timelineUs: irTimeUs(3_000_000), gain: 0.25 },
          ],
        },
        timeUs(2_000_000),
      ),
    ).toBeCloseTo(0.15625);
  });
});

describe("WebAudioScheduler", () => {
  it("trims a decoded audio buffer that begins before the requested source time", async () => {
    const node = new FakeBufferSourceNode();
    const scheduler = new WebAudioScheduler(audioContext(node));
    scheduler.startTransport(timeUs(2_000_000));

    await scheduler.schedule(
      audioSource(900_000),
      timeUs(1_000_000),
      timeUs(2_000_000),
      timeUs(500_000),
    );

    expect(node.starts).toHaveLength(1);
    expect(node.starts[0]![0]).toBeCloseTo(10.05);
    expect(node.starts[0]![1]).toBeCloseTo(0.1);
    expect(node.starts[0]![2]).toBeCloseTo(0.5);
    expect(() => scheduler.stop()).not.toThrow();
    expect(node.stops).toBe(1);
  });

  it("does not retain a source node when starting it fails", async () => {
    const node = new FakeBufferSourceNode(new Error("start failed"));
    const scheduler = new WebAudioScheduler(audioContext(node));
    scheduler.startTransport(timeUs(0));

    await expect(
      scheduler.schedule(audioSource(0), timeUs(0), timeUs(0), timeUs(500_000)),
    ).rejects.toThrow("start failed");
    expect(() => scheduler.stop()).not.toThrow();
    expect(node.stops).toBe(0);
    expect(node.disconnects).toBe(1);
  });

  it("applies canonical pan and ducking automation before the master mix", async () => {
    const node = new FakeBufferSourceNode();
    const observations: AudioObservations = { gains: [], pans: [] };
    const scheduler = new WebAudioScheduler(audioContext(node, observations));
    scheduler.startTransport(timeUs(0));

    await scheduler.schedule(audioSource(0, 2), timeUs(0), timeUs(0), timeUs(2_000_000), {
      timelineStartUs: timeUs(0),
      timelineEndUs: timeUs(2_000_000),
      fadeInUs: timeUs(0),
      fadeOutUs: timeUs(0),
      gain: 0.5,
      pan: 0.75,
      ducking: [
        { timelineUs: irTimeUs(0), gain: 1 },
        { timelineUs: irTimeUs(1_000_000), gain: 0.25 },
        { timelineUs: irTimeUs(2_000_000), gain: 1 },
      ],
    });

    expect(observations.pans.at(-1)).toBe(0.75);
    expect(observations.gains).toEqual([0.5, 0.125, 0.5]);
  });
});

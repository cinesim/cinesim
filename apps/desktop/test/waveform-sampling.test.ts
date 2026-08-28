import { describe, expect, it } from "vite-plus/test";
import {
  accumulateWaveformSample,
  type PlanarAudioSample,
} from "../src/renderer/lib/waveform-sampling";

describe("worker waveform sampling", () => {
  it("reduces planar decoded samples without constructing an AudioBuffer", () => {
    const planes = [new Float32Array([-0.5, 0.25]), new Float32Array([-0.75, 0.5])];
    const sample: PlanarAudioSample = {
      timestamp: 0,
      sampleRate: 2,
      numberOfFrames: 2,
      numberOfChannels: 2,
      copyTo: (destination, options) => destination.set(planes[options.planeIndex]!),
    };
    const minima = new Float32Array(2);
    const maxima = new Float32Array(2);

    accumulateWaveformSample(sample, 1, minima, maxima);

    expect([...minima]).toEqual([-0.75, 0]);
    expect([...maxima]).toEqual([0, 0.5]);
  });

  it("clamps timestamps that land outside the declared duration", () => {
    const sample: PlanarAudioSample = {
      timestamp: 2,
      sampleRate: 48_000,
      numberOfFrames: 1,
      numberOfChannels: 1,
      copyTo: (destination) => destination.set([-1]),
    };
    const minima = new Float32Array(2);
    const maxima = new Float32Array(2);

    accumulateWaveformSample(sample, 1, minima, maxima);

    expect([...minima]).toEqual([0, -1]);
  });
});

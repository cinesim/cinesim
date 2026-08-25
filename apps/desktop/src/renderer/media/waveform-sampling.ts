export interface PlanarAudioSample {
  timestamp: number;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: "f32-planar" }): void;
}

/** Reduce one decoded Mediabunny audio sample without requiring Web Audio's AudioBuffer. */
export function accumulateWaveformSample(
  sample: PlanarAudioSample,
  durationSeconds: number,
  minima: Float32Array,
  maxima: Float32Array,
): void {
  if (minima.length === 0 || minima.length !== maxima.length)
    throw new Error("Waveform peak arrays must be non-empty and match");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new Error("Waveform duration must be positive");
  const channelData = new Float32Array(sample.numberOfFrames);
  for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
    sample.copyTo(channelData, { planeIndex: channel, format: "f32-planar" });
    for (let frame = 0; frame < sample.numberOfFrames; frame += 1) {
      const timestamp = sample.timestamp + frame / sample.sampleRate;
      const peakIndex = Math.max(
        0,
        Math.min(minima.length - 1, Math.floor((timestamp / durationSeconds) * minima.length)),
      );
      const value = channelData[frame] ?? 0;
      if (value < minima[peakIndex]!) minima[peakIndex] = value;
      if (value > maxima[peakIndex]!) maxima[peakIndex] = value;
    }
  }
}

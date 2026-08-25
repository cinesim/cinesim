export const WAVEFORM_FORMAT_VERSION = 1;
export const WAVEFORM_MAX_PEAKS = 4_096;
export const WAVEFORM_HEADER_BYTES = 16;
export const WAVEFORM_BYTES_PER_PEAK = 4;

const MAGIC = [0x43, 0x53, 0x57, 0x46] as const; // CSWF
const ENVELOPE_CHANNELS = 1;
const INT16_MAX = 0x7fff;

export interface WaveformEnvelope {
  version: typeof WAVEFORM_FORMAT_VERSION;
  peakCount: number;
  /** Interleaved signed 16-bit minimum/maximum pairs. */
  peaks: Int16Array;
}

export function waveformPeakCount(durationUs: number): number {
  if (!Number.isSafeInteger(durationUs) || durationUs < 0)
    throw new Error("Invalid waveform duration");
  // Roughly one peak per 50 ms remains useful for short clips while the hard cap
  // keeps multi-hour source artifacts small and predictable.
  return Math.max(1, Math.min(WAVEFORM_MAX_PEAKS, Math.ceil(durationUs / 50_000)));
}

export function waveformByteLength(peakCount: number): number {
  assertPeakCount(peakCount);
  return WAVEFORM_HEADER_BYTES + peakCount * WAVEFORM_BYTES_PER_PEAK;
}

export function encodeWaveformEnvelope(minima: Float32Array, maxima: Float32Array): ArrayBuffer {
  if (minima.length !== maxima.length) throw new Error("Waveform peak arrays must match");
  assertPeakCount(minima.length);
  const buffer = new ArrayBuffer(waveformByteLength(minima.length));
  const view = new DataView(buffer);
  for (let index = 0; index < MAGIC.length; index += 1) view.setUint8(index, MAGIC[index]!);
  view.setUint16(4, WAVEFORM_FORMAT_VERSION, true);
  view.setUint16(6, ENVELOPE_CHANNELS, true);
  view.setUint32(8, minima.length, true);
  view.setUint32(12, 0, true);
  for (let index = 0; index < minima.length; index += 1) {
    const minimum = quantize(Math.min(0, finiteSample(minima[index])));
    const maximum = quantize(Math.max(0, finiteSample(maxima[index])));
    const offset = WAVEFORM_HEADER_BYTES + index * WAVEFORM_BYTES_PER_PEAK;
    view.setInt16(offset, minimum, true);
    view.setInt16(offset + 2, maximum, true);
  }
  return buffer;
}

export function decodeWaveformEnvelope(buffer: ArrayBuffer): WaveformEnvelope {
  if (buffer.byteLength < WAVEFORM_HEADER_BYTES) throw new Error("Waveform artifact is truncated");
  const view = new DataView(buffer);
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (view.getUint8(index) !== MAGIC[index]) throw new Error("Unknown waveform artifact");
  }
  const version = view.getUint16(4, true);
  const channels = view.getUint16(6, true);
  const peakCount = view.getUint32(8, true);
  if (version !== WAVEFORM_FORMAT_VERSION || channels !== ENVELOPE_CHANNELS)
    throw new Error("Unsupported waveform artifact");
  assertPeakCount(peakCount);
  if (buffer.byteLength !== waveformByteLength(peakCount))
    throw new Error("Waveform artifact has an invalid size");
  const peaks = new Int16Array(peakCount * 2);
  for (let index = 0; index < peaks.length; index += 1)
    peaks[index] = view.getInt16(WAVEFORM_HEADER_BYTES + index * 2, true);
  return { version: WAVEFORM_FORMAT_VERSION, peakCount, peaks };
}

function assertPeakCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > WAVEFORM_MAX_PEAKS)
    throw new Error("Invalid waveform peak count");
}

function finiteSample(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value!)) : 0;
}

function quantize(value: number): number {
  return Math.round(value * INT16_MAX);
}

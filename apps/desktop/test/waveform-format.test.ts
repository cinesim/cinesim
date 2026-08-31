import { describe, expect, it } from "vite-plus/test";
import {
  decodeWaveformEnvelope,
  encodeWaveformEnvelope,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAX_PEAKS,
  waveformByteLength,
  waveformPeakCount,
} from "../src/shared/waveform-format";

describe("waveform format", () => {
  it("chooses a deterministic bounded peak count", () => {
    expect(waveformPeakCount(0)).toBe(1);
    expect(waveformPeakCount(1_000_000)).toBe(200);
    expect(waveformPeakCount(86_400_000_000)).toBe(WAVEFORM_MAX_PEAKS);
  });

  it("round trips a compact signed peak envelope", () => {
    const encoded = encodeWaveformEnvelope(
      new Float32Array([-1, -0.25, 0.5, Number.NaN]),
      new Float32Array([1, 0.5, -0.5, Number.POSITIVE_INFINITY]),
    );
    expect(encoded.byteLength).toBe(WAVEFORM_HEADER_BYTES + 4 * 4);
    const decoded = decodeWaveformEnvelope(encoded);
    expect(decoded.peakCount).toBe(4);
    expect([...decoded.peaks]).toEqual([-32767, 32767, -8192, 16384, 0, 0, 0, 0]);
  });

  it("rejects malformed and oversized artifacts", () => {
    expect(() => decodeWaveformEnvelope(new ArrayBuffer(4))).toThrow("truncated");
    expect(() => waveformByteLength(WAVEFORM_MAX_PEAKS + 1)).toThrow("peak count");
    const encoded = encodeWaveformEnvelope(new Float32Array([0]), new Float32Array([0]));
    expect(() => decodeWaveformEnvelope(encoded.slice(0, -1))).toThrow("invalid size");
  });
});

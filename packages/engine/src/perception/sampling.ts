import { timeUs } from "@cinesim/core";
import type { TimeUs } from "@cinesim/core";

export function sparseSampleTimes(
  durationUs: TimeUs,
  intervalUs: TimeUs = timeUs(5_000_000),
  fromUs: TimeUs = timeUs(0),
  toUs: TimeUs = durationUs,
): TimeUs[] {
  if (intervalUs <= 0 || !Number.isSafeInteger(intervalUs))
    throw new Error("Interval must be positive integer microseconds");
  const end = Math.min(durationUs, toUs);
  const output: TimeUs[] = [];
  for (let sampleUs = timeUs(Math.max(0, fromUs)); sampleUs < end;) {
    output.push(sampleUs);
    sampleUs = timeUs(sampleUs + intervalUs);
  }
  if (end > fromUs && output.at(-1) !== end - 1) output.push(timeUs(Math.max(fromUs, end - 1)));
  return output;
}

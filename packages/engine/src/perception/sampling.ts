import type { TimeUs } from "@cinesim/core";

export function sparseSampleTimes(
  durationUs: TimeUs,
  intervalUs: TimeUs = 5_000_000,
  fromUs: TimeUs = 0,
  toUs: TimeUs = durationUs,
): TimeUs[] {
  if (intervalUs <= 0 || !Number.isSafeInteger(intervalUs))
    throw new Error("Interval must be positive integer microseconds");
  const end = Math.min(durationUs, toUs);
  const output: TimeUs[] = [];
  for (let timeUs = Math.max(0, fromUs); timeUs < end; timeUs += intervalUs) output.push(timeUs);
  if (end > fromUs && output.at(-1) !== end - 1) output.push(Math.max(fromUs, end - 1));
  return output;
}

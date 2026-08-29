import { timeUs } from "@cinesim/core";
import type { TimeUs } from "@cinesim/core";

export function parseTime(value: string): TimeUs {
  const input = value.trim().toLowerCase();
  if (/^\d+:\d\d(?::\d\d(?:\.\d+)?)?$/.test(input)) {
    const parts = input.split(":").map(Number);
    const seconds =
      parts.length === 3
        ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
        : parts[0]! * 60 + parts[1]!;
    return timeUs(Math.round(seconds * 1_000_000));
  }
  const match = input.match(/^(\d+(?:\.\d+)?)(us|ms|s|m|h)?$/);
  if (!match) throw new Error(`Invalid time: ${value}. Use 4.2s, 250ms, 3m, or 01:23.500.`);
  const amount = Number(match[1]);
  const multiplier = { us: 1, ms: 1_000, s: 1_000_000, m: 60_000_000, h: 3_600_000_000 }[
    match[2] ?? "s"
  ]!;
  const parsedTimeUs = Math.round(amount * multiplier);
  if (!Number.isSafeInteger(parsedTimeUs)) throw new Error("Time is outside the supported range");
  return timeUs(parsedTimeUs);
}

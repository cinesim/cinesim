import { timeUs } from "../project/types";
import { CommandError, type TimelineRange } from "./command-types";

const MAX_RANGES = 500;

function assertRangeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommandError(
      "INVALID_TIME",
      `${label} must be a non-negative integer number of microseconds`,
    );
  }
}

/** Sorts and merges touching ranges so every caller gets identical canonical semantics. */
export function normalizeTimelineRanges(ranges: readonly TimelineRange[]): TimelineRange[] {
  if (ranges.length === 0) {
    throw new CommandError("EMPTY_RANGE_SELECTION", "Select at least one timeline range");
  }
  if (ranges.length > MAX_RANGES) {
    throw new CommandError("TOO_MANY_RANGES", `A range edit accepts at most ${MAX_RANGES} ranges`);
  }
  const sorted = ranges
    .map((range, index) => {
      assertRangeTime(range.startUs, `ranges[${index}].startUs`);
      assertRangeTime(range.endUs, `ranges[${index}].endUs`);
      if (range.endUs <= range.startUs) {
        throw new CommandError(
          "INVALID_RANGE",
          `ranges[${index}] must end strictly after it starts`,
        );
      }
      return { startUs: range.startUs, endUs: range.endUs };
    })
    .sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);

  const normalized: TimelineRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (!previous || range.startUs > previous.endUs) normalized.push(range);
    else previous.endUs = timeUs(Math.max(previous.endUs, range.endUs));
  }
  return normalized;
}

import type { ClipId, TimeUs } from "@cinesim/core";
import { normalizeTimelineRanges, timeUs } from "@cinesim/core";
import type { ProjectedTranscriptWord } from "./projection-types";

export function timelineRangesForWordIds(
  words: readonly ProjectedTranscriptWord[],
  selectedWordIds: ReadonlySet<string>,
) {
  const selected = words
    .filter((word) => selectedWordIds.has(word.id))
    .sort(
      (left, right) =>
        left.timelineStartUs - right.timelineStartUs || left.id.localeCompare(right.id),
    );
  const ranges: Array<{ clipId: ClipId; startUs: TimeUs; endUs: TimeUs }> = [];
  for (const word of selected) {
    const previous = ranges.at(-1);
    if (previous?.clipId === word.clipId) {
      previous.endUs = timeUs(Math.max(previous.endUs, word.timelineEndUs));
    } else {
      ranges.push({
        clipId: word.clipId,
        startUs: word.timelineStartUs,
        endUs: word.timelineEndUs,
      });
    }
  }
  return normalizeTimelineRanges(ranges.map(({ startUs, endUs }) => ({ startUs, endUs })));
}

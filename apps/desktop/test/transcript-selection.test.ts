import { describe, expect, it } from "vite-plus/test";
import { timeUs } from "@cinesim/core";
import type { SelectableTranscriptToken } from "../src/renderer/components/transcript/transcript-selection";
import {
  mergeTranscriptRanges,
  selectTranscriptTokenRange,
} from "../src/renderer/components/transcript/transcript-selection";

function token(id: string, start: number, end: number): SelectableTranscriptToken {
  return {
    id,
    startUs: timeUs(start),
    endUs: timeUs(end),
  };
}

const tokens = [token("one", 0, 10), token("two", 10, 20), token("three", 20, 30)];

describe("transcript selection", () => {
  it("selects one token and establishes its anchor", () => {
    const selection = selectTranscriptTokenRange(tokens, null, "two", false);

    expect([...selection!.selectedIds]).toEqual(["two"]);
    expect(selection!.anchorId).toBe("two");
  });

  it("extends from the anchor in either direction", () => {
    const forward = selectTranscriptTokenRange(tokens, "one", "three", true);
    const backward = selectTranscriptTokenRange(tokens, "three", "one", true);

    expect([...forward!.selectedIds]).toEqual(["one", "two", "three"]);
    expect([...backward!.selectedIds]).toEqual(["one", "two", "three"]);
  });

  it("uses the target as a new anchor when the previous anchor disappeared", () => {
    const selection = selectTranscriptTokenRange(tokens, "missing", "two", true);

    expect([...selection!.selectedIds]).toEqual(["two"]);
    expect(selection!.anchorId).toBe("two");
  });

  it("ignores a target outside the transcript", () => {
    expect(selectTranscriptTokenRange(tokens, "one", "missing", true)).toBeNull();
  });

  it("merges overlapping ranges but preserves disconnected ranges", () => {
    expect(
      mergeTranscriptRanges([
        token("late", 8, 15),
        token("early", 0, 10),
        token("separate", 20, 30),
      ]),
    ).toEqual([
      { startUs: timeUs(0), endUs: timeUs(15) },
      { startUs: timeUs(20), endUs: timeUs(30) },
    ]);
  });
});

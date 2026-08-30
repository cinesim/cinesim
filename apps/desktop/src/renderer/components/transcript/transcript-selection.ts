import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { timeUs } from "@cinesim/core";
import type { TimelineRange, TimeUs } from "@cinesim/core";
import type { TranscriptDocumentBlock } from "../../../shared/transcript";

export interface SelectableTranscriptToken {
  id: string;
  startUs: TimeUs;
  endUs: TimeUs;
}

export interface TranscriptTokenSelection {
  anchorId: string;
  selectedIds: Set<string>;
}

interface UseTranscriptSelectionOptions {
  blocks: readonly TranscriptDocumentBlock[];
  onSeek: (timeUs: TimeUs) => void;
  onSelectionChange: (ranges: TimelineRange[]) => void;
}

export function formatTranscriptDuration(durationUs: number): string {
  const seconds = durationUs / 1_000_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

export function selectableTranscriptTokens(
  blocks: readonly TranscriptDocumentBlock[],
): SelectableTranscriptToken[] {
  const result: SelectableTranscriptToken[] = [];
  for (const block of blocks) {
    if (block.kind === "timeline-gap") {
      result.push({
        id: block.gap.id,
        startUs: block.gap.timelineStartUs,
        endUs: block.gap.timelineEndUs,
      });
      continue;
    }
    if (block.kind !== "utterance") continue;
    for (const token of block.utterance.tokens) {
      result.push(
        token.kind === "word"
          ? {
              id: token.word.id,
              startUs: token.word.timelineStartUs,
              endUs: token.word.timelineEndUs,
            }
          : {
              id: token.id,
              startUs: token.timelineStartUs,
              endUs: token.timelineEndUs,
            },
      );
    }
  }
  return result;
}

export function mergeTranscriptRanges(
  items: readonly SelectableTranscriptToken[],
): TimelineRange[] {
  const sorted = items
    .map((item) => ({ startUs: item.startUs, endUs: item.endUs }))
    .sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);
  const result: TimelineRange[] = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.startUs <= previous.endUs)
      previous.endUs = timeUs(Math.max(previous.endUs, range.endUs));
    else result.push({ ...range });
  }
  return result;
}

export function selectTranscriptTokenRange(
  tokens: readonly SelectableTranscriptToken[],
  anchorId: string | null,
  targetId: string,
  extend: boolean,
): TranscriptTokenSelection | null {
  const targetIndex = tokens.findIndex((token) => token.id === targetId);
  if (targetIndex < 0) return null;
  const requestedAnchor =
    extend && anchorId ? tokens.findIndex((token) => token.id === anchorId) : -1;
  const anchorIndex = requestedAnchor >= 0 ? requestedAnchor : targetIndex;
  const low = Math.min(anchorIndex, targetIndex);
  const high = Math.max(anchorIndex, targetIndex);
  return {
    anchorId: requestedAnchor >= 0 && anchorId ? anchorId : targetId,
    selectedIds: new Set(tokens.slice(low, high + 1).map((token) => token.id)),
  };
}

export function useTranscriptSelection({
  blocks,
  onSeek,
  onSelectionChange,
}: UseTranscriptSelectionOptions) {
  const tokens = useMemo(() => selectableTranscriptTokens(blocks), [blocks]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const dragging = useRef(false);
  const selectedTokens = useMemo(
    () => tokens.filter((token) => selectedIds.has(token.id)),
    [selectedIds, tokens],
  );
  const ranges = useMemo(() => mergeTranscriptRanges(selectedTokens), [selectedTokens]);
  const selectionKey = ranges.map((range) => `${range.startUs}:${range.endUs}`).join(",");
  const publishedSelection = useRef<{
    key: string;
    listener: UseTranscriptSelectionOptions["onSelectionChange"];
  } | null>(null);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    setAnchorId(null);
  }, []);

  const selectThrough = useCallback(
    (id: string, extend: boolean) => {
      const next = selectTranscriptTokenRange(tokens, anchorId, id, extend);
      if (!next) return;
      setSelectedIds(next.selectedIds);
      setAnchorId(next.anchorId);
      const token = tokens.find((candidate) => candidate.id === id);
      if (token) onSeek(token.startUs);
    },
    [anchorId, onSeek, tokens],
  );

  const begin = useCallback(
    (id: string, event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      dragging.current = true;
      selectThrough(id, event.shiftKey);
    },
    [selectThrough],
  );

  const enter = useCallback(
    (id: string, event: PointerEvent<HTMLButtonElement>) => {
      if (dragging.current && event.buttons & 1) selectThrough(id, true);
    },
    [selectThrough],
  );

  useEffect(() => {
    const published = publishedSelection.current;
    if (published?.key === selectionKey && published.listener === onSelectionChange) return;
    publishedSelection.current = { key: selectionKey, listener: onSelectionChange };
    onSelectionChange(ranges);
  }, [onSelectionChange, ranges, selectionKey]);

  useEffect(() => {
    const stopDragging = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stopDragging);
    return () => window.removeEventListener("pointerup", stopDragging);
  }, []);

  return {
    begin,
    clear,
    enter,
    ranges,
    selectedIds,
    selectedTokens,
    selectThrough,
  };
}

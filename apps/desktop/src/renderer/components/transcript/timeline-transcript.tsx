import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoveHorizontal, Play, Sparkles, Trash2, X } from "@cinesim/ui";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@cinesim/ui";
import { timeUs, type Project, type TimelineRange, type TimeUs } from "@cinesim/core";
import type { DerivedProjectScope } from "../../../shared/contracts";
import { projectScreenplayEntries } from "../../../shared/screenplay";
import {
  captionTrackFromTranscriptSelection,
  projectTimelineTranscript,
  transcriptDocumentSections,
} from "../../../shared/transcript";
import { isEditableKeyboardTarget } from "../../lib/keyboard-target";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorTransport } from "../workspace/editor-transport-context";
import { TranscriptDocument } from "./transcript-document";
import { formatTranscriptDuration, useTranscriptSelection } from "./transcript-selection";
import {
  filterTranscriptSections,
  TranscriptToolbar,
  transcriptSpeakerOptions,
} from "./transcript-toolbar";
import { useScreenplayVisuals } from "./use-screenplay-visuals";

interface TimelineTranscriptProps {
  project: Project;
  sequenceId: string;
  derivedScope: DerivedProjectScope;
  markers: readonly { id: string; atUs: number; name: string }[];
  onSelectionChange: (ranges: TimelineRange[]) => void;
}

export function TimelineTranscript({
  project,
  sequenceId,
  derivedScope,
  markers,
  onSelectionChange,
}: TimelineTranscriptProps) {
  const account = useRendererStore((state) => state.account);
  const cancelTranscripts = useRendererStore((state) => state.cancelTranscripts);
  const execute = useRendererStore((state) => state.execute);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const requestTranscripts = useRendererStore((state) => state.requestTranscripts);
  const transcripts = useRendererStore((state) => state.transcripts);
  const transport = useEditorTransport();
  const reportError = useRendererStore((state) => state.reportError);
  const screenplay = useScreenplayVisuals(project, sequenceId, derivedScope);
  const projection = useMemo(
    () => projectTimelineTranscript({ project, sequenceId, transcripts }),
    [project, sequenceId, transcripts],
  );
  const sections = useMemo(
    () => transcriptDocumentSections(projection.blocks),
    [projection.blocks],
  );
  const speakers = useMemo(() => transcriptSpeakerOptions(projection.blocks), [projection.blocks]);
  const speakerColors = useMemo(
    () => new Map(speakers.map((speaker) => [speaker.id, speaker.color])),
    [speakers],
  );
  const [query, setQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [screenplayRange, setScreenplayRange] = useState<TimelineRange | null>(null);
  const [selectedScreenplayId, setSelectedScreenplayId] = useState<string | null>(null);
  const screenplayRangeRef = useRef<TimelineRange | null>(null);
  const seekTimeline = useCallback(
    (timeUs: TimeUs) => void transport.seekTimeline(timeUs),
    [transport],
  );
  const visibleSections = useMemo(
    () => filterTranscriptSections(sections, query, speakerFilter),
    [query, sections, speakerFilter],
  );
  const screenplayEntries = useMemo(
    () => projectScreenplayEntries(project, sequenceId, screenplay.visuals, markers),
    [markers, project, screenplay.visuals, sequenceId],
  );
  const acceptTranscriptSelection = useCallback(
    (ranges: TimelineRange[]) => {
      if (!screenplayRangeRef.current) onSelectionChange(ranges);
    },
    [onSelectionChange],
  );
  const selection = useTranscriptSelection({
    blocks: projection.blocks,
    onSeek: seekTimeline,
    onSelectionChange: acceptTranscriptSelection,
  });
  const clearTranscriptSelection = selection.clear;
  const selectScreenplayEntry = useCallback(
    (id: string, startUs: number, endUs: number) => {
      const range = { startUs: timeUs(startUs), endUs: timeUs(endUs) };
      screenplayRangeRef.current = range;
      setScreenplayRange(range);
      setSelectedScreenplayId(id);
      clearTranscriptSelection();
      onSelectionChange([range]);
      seekTimeline(range.startUs);
    },
    [clearTranscriptSelection, onSelectionChange, seekTimeline],
  );
  const clearSelection = useCallback(() => {
    screenplayRangeRef.current = null;
    setScreenplayRange(null);
    setSelectedScreenplayId(null);
    clearTranscriptSelection();
    onSelectionChange([]);
  }, [clearTranscriptSelection, onSelectionChange]);
  const transcriptSelection = useMemo(
    () => ({
      ...selection,
      begin: (id: string, event: Parameters<typeof selection.begin>[1]) => {
        screenplayRangeRef.current = null;
        setScreenplayRange(null);
        setSelectedScreenplayId(null);
        selection.begin(id, event);
      },
      selectThrough: (id: string, extend: boolean) => {
        screenplayRangeRef.current = null;
        setScreenplayRange(null);
        setSelectedScreenplayId(null);
        selection.selectThrough(id, extend);
      },
    }),
    [selection],
  );
  const selectedRanges = useMemo(
    () => (screenplayRange ? [screenplayRange] : selection.ranges),
    [screenplayRange, selection.ranges],
  );
  const selectionStart = selectedRanges[0]?.startUs;
  const selectionEnd = selectedRanges.at(-1)?.endUs;
  const selectedCaptionWords = useMemo(
    () => projection.words.filter(({ id }) => selection.selectedIds.has(id)),
    [projection.words, selection.selectedIds],
  );

  useEffect(() => {
    function deleteSelection(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        isEditableKeyboardTarget(event.target) ||
        (event.key !== "Backspace" && event.key !== "Delete") ||
        selectedRanges.length === 0
      )
        return;
      event.preventDefault();
      void execute({
        type: "sequence.deleteRanges",
        sequenceId: sequenceId as `sequence_${string}`,
        ranges: selectedRanges,
        mode: "ripple",
      }).then((result) => {
        if (result.ok) clearSelection();
      });
    }
    window.addEventListener("keydown", deleteSelection);
    return () => window.removeEventListener("keydown", deleteSelection);
  }, [clearSelection, execute, selectedRanges, sequenceId]);

  async function deleteRanges(mode: "ripple" | "lift") {
    if (!selectedRanges.length) return;
    const result = await execute({
      type: "sequence.deleteRanges",
      sequenceId: sequenceId as `sequence_${string}`,
      ranges: selectedRanges,
      mode,
    });
    if (result.ok) clearSelection();
  }

  async function generateCaptions() {
    if (!transcripts || selectedCaptionWords.length === 0) return;
    try {
      const track = captionTrackFromTranscriptSelection({
        sequenceId,
        words: selectedCaptionWords,
        transcripts,
      });
      const result = await execute({
        type: "caption.generate",
        sequenceId: sequenceId as `sequence_${string}`,
        track,
      });
      if (result.ok) clearSelection();
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-panel"
      aria-label="Timeline transcript"
    >
      <TranscriptToolbar
        query={query}
        speakerFilter={speakerFilter}
        speakers={speakers}
        onQueryChange={setQuery}
        onSpeakerChange={setSpeakerFilter}
      />

      <ContextMenu>
        <ContextMenuTrigger
          className="min-h-0 flex-1 overflow-auto px-4 py-4"
          onContextMenu={(event) => {
            const tokenElement =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-transcript-token-id]")
                : null;
            const tokenId = tokenElement?.dataset.transcriptTokenId;
            if (tokenId) {
              if (!selection.selectedIds.has(tokenId)) selection.selectThrough(tokenId, false);
            } else if (selection.selectedTokens.length === 0) event.preventBaseUIHandler();
          }}
        >
          <TranscriptDocument
            canTranscribe={account.status === "signed-in" && account.transcription}
            hasFilters={Boolean(speakerFilter || query)}
            hasTranscriptContent={projection.blocks.length > 0}
            playheadUs={playheadUs}
            sections={visibleSections}
            selection={transcriptSelection}
            signedIn={account.status === "signed-in"}
            speakerColors={speakerColors}
            screenplay={{
              entries: screenplayEntries,
              loading: screenplay.loading,
              error: screenplay.error,
              selectedId: selectedScreenplayId,
              onSelect: selectScreenplayEntry,
              onCorrect: (assetId, observation, description) =>
                void screenplay
                  .correct(assetId, observation, description)
                  .catch((error) =>
                    reportError(error instanceof Error ? error.message : String(error)),
                  ),
              onSplit: (assetId, observation) =>
                void screenplay
                  .split(assetId, observation)
                  .catch((error) =>
                    reportError(error instanceof Error ? error.message : String(error)),
                  ),
              onMergeNext: (assetId, observation) =>
                void screenplay
                  .mergeNext(assetId, observation)
                  .catch((error) =>
                    reportError(error instanceof Error ? error.message : String(error)),
                  ),
              onGenerate: (assetId, force) =>
                void screenplay
                  .generate(assetId, force)
                  .catch((error) =>
                    reportError(error instanceof Error ? error.message : String(error)),
                  ),
              onClear: (assetId) =>
                void screenplay
                  .clear(assetId)
                  .catch((error) =>
                    reportError(error instanceof Error ? error.message : String(error)),
                  ),
            }}
            onCancelTranscript={(assetId) => void cancelTranscripts([assetId])}
            onRequestTranscript={(assetId) => void requestTranscripts([assetId])}
          />
        </ContextMenuTrigger>
        <ContextMenuContent aria-label="Transcript selection actions" className="w-56 text-ui">
          <p className="px-2.5 py-1.5 text-ui-xs font-medium text-muted">
            Selection · {formatTranscriptDuration((selectionEnd ?? 0) - (selectionStart ?? 0))}
          </p>
          <ContextMenuItem
            onClick={() => {
              if (selectionStart !== undefined && selectionEnd !== undefined)
                void transport.playRange(selectionStart, selectionEnd);
            }}
          >
            <Play size={14} /> Play selection
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!transcripts || selectedCaptionWords.length === 0}
            onClick={() => void generateCaptions()}
          >
            <Sparkles size={14} /> Generate caption track
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void deleteRanges("ripple")}>
            <Trash2 size={14} /> Delete and close gap
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void deleteRanges("lift")}>
            <MoveHorizontal size={14} /> Lift and leave gap
          </ContextMenuItem>
          <ContextMenuItem onClick={clearSelection}>
            <X size={14} /> Clear selection
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </section>
  );
}

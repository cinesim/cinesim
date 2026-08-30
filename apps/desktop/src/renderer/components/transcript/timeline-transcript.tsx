import { useEffect, useMemo, useState } from "react";
import { MoveHorizontal, Play, Trash2, X } from "@cinesim/ui";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@cinesim/ui";
import type { AssetId, EditorCommand, Project, TimelineRange, TimeUs } from "@cinesim/core";
import type { TranscriptSnapshot } from "../../../shared/transcript";
import { projectTimelineTranscript, transcriptDocumentSections } from "../../../shared/transcript";
import { isEditableKeyboardTarget } from "../../lib/keyboard-target";
import type { ActionResult, RendererState } from "../../store/renderer-store";
import { TranscriptDocument } from "./transcript-document";
import { formatTranscriptDuration, useTranscriptSelection } from "./transcript-selection";
import {
  filterTranscriptSections,
  TranscriptToolbar,
  transcriptSpeakerOptions,
} from "./transcript-toolbar";

interface TimelineTranscriptProps {
  project: Project;
  sequenceId: string;
  transcripts: TranscriptSnapshot | null;
  account: RendererState["account"];
  playheadUs: TimeUs;
  onSeek: (timeUs: TimeUs) => void;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  onRequestTranscripts: (assetIds: AssetId[]) => Promise<ActionResult<TranscriptSnapshot>>;
  onCancelTranscripts: (assetIds: AssetId[]) => Promise<ActionResult<TranscriptSnapshot>>;
  onSelectionChange: (ranges: TimelineRange[]) => void;
  onPlaySelection: (startUs: TimeUs, endUs: TimeUs) => void;
}

export function TimelineTranscript({
  project,
  sequenceId,
  transcripts,
  account,
  playheadUs,
  onSeek,
  onCommand,
  onRequestTranscripts,
  onCancelTranscripts,
  onSelectionChange,
  onPlaySelection,
}: TimelineTranscriptProps) {
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
  const visibleSections = useMemo(
    () => filterTranscriptSections(sections, query, speakerFilter),
    [query, sections, speakerFilter],
  );
  const selection = useTranscriptSelection({
    blocks: projection.blocks,
    onSeek,
    onSelectionChange,
  });
  const clearSelection = selection.clear;
  const selectedRanges = selection.ranges;
  const selectionStart = selectedRanges[0]?.startUs;
  const selectionEnd = selectedRanges.at(-1)?.endUs;

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
      void onCommand({
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
  }, [clearSelection, onCommand, selectedRanges, sequenceId]);

  async function deleteRanges(mode: "ripple" | "lift") {
    if (!selectedRanges.length) return;
    const result = await onCommand({
      type: "sequence.deleteRanges",
      sequenceId: sequenceId as `sequence_${string}`,
      ranges: selectedRanges,
      mode,
    });
    if (result.ok) clearSelection();
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
            selection={selection}
            signedIn={account.status === "signed-in"}
            speakerColors={speakerColors}
            onCancelTranscript={(assetId) => void onCancelTranscripts([assetId])}
            onRequestTranscript={(assetId) => void onRequestTranscripts([assetId])}
          />
        </ContextMenuTrigger>
        <ContextMenuContent aria-label="Transcript selection actions" className="w-56 text-ui">
          <p className="px-2.5 py-1.5 text-ui-xs font-medium text-muted">
            Selection · {formatTranscriptDuration((selectionEnd ?? 0) - (selectionStart ?? 0))}
          </p>
          <ContextMenuItem
            onClick={() => {
              if (selectionStart !== undefined && selectionEnd !== undefined)
                onPlaySelection(selectionStart, selectionEnd);
            }}
          >
            <Play size={14} /> Play selection
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

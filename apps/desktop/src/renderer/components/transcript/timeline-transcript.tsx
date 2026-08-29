import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Trash2,
  User,
  Play,
  LoaderCircle,
  RotateCcw,
  MoveHorizontal,
  X,
} from "@cinesim/ui";
import { Button, cn, Menu, MenuContent, MenuItem, MenuTrigger, SearchField } from "@cinesim/ui";
import type { AssetId, EditorCommand, Project, TimelineRange } from "@cinesim/core";
import type { TranscriptSnapshot } from "../../../shared/transcript";
import {
  projectTimelineTranscript,
  transcriptDocumentSections,
  type TranscriptDocumentBlock,
  type TranscriptDocumentSection,
  type TranscriptInlineToken,
} from "../../../shared/transcript";
import type { ActionResult, RendererState } from "../../store/renderer-store";
import { useTranscriptionConsent } from "./transcription-consent";

interface TimelineTranscriptProps {
  project: Project;
  sequenceId: string;
  transcripts: TranscriptSnapshot | null;
  account: RendererState["account"];
  playheadUs: number;
  onSeek: (timeUs: number) => void;
  onCommand: (command: EditorCommand) => Promise<ActionResult<unknown>>;
  onRequestTranscripts: (assetIds: AssetId[]) => Promise<ActionResult<TranscriptSnapshot>>;
  onCancelTranscripts: (assetIds: AssetId[]) => Promise<ActionResult<TranscriptSnapshot>>;
  onSelectionChange: (ranges: TimelineRange[]) => void;
  onPlaySelection: (startUs: number, endUs: number) => void;
}

interface SelectableToken {
  id: string;
  kind: "word" | "media-silence" | "timeline-gap";
  startUs: number;
  endUs: number;
  label: string;
}

const SPEAKER_COLORS = [
  "var(--metric-blue)",
  "var(--metric-violet)",
  "var(--metric-green)",
  "var(--metric-amber)",
] as const;

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function formatSeconds(durationUs: number): string {
  const seconds = durationUs / 1_000_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

function mergeRanges(items: readonly SelectableToken[]): TimelineRange[] {
  const sorted = items
    .map((item) => ({ startUs: item.startUs, endUs: item.endUs }))
    .sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);
  const result: TimelineRange[] = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.startUs <= previous.endUs)
      previous.endUs = Math.max(previous.endUs, range.endUs);
    else result.push({ ...range });
  }
  return result;
}

function selectableTokens(blocks: readonly TranscriptDocumentBlock[]): SelectableToken[] {
  const result: SelectableToken[] = [];
  for (const block of blocks) {
    if (block.kind === "timeline-gap") {
      result.push({
        id: block.gap.id,
        kind: "timeline-gap",
        startUs: block.gap.timelineStartUs,
        endUs: block.gap.timelineEndUs,
        label: "Timeline gap",
      });
      continue;
    }
    if (block.kind !== "utterance") continue;
    for (const token of block.utterance.tokens) {
      result.push(
        token.kind === "word"
          ? {
              id: token.word.id,
              kind: "word",
              startUs: token.word.timelineStartUs,
              endUs: token.word.timelineEndUs,
              label: token.word.text,
            }
          : {
              id: token.id,
              kind: "media-silence",
              startUs: token.timelineStartUs,
              endUs: token.timelineEndUs,
              label: "Silence",
            },
      );
    }
  }
  return result;
}

function sectionMatches(
  section: TranscriptDocumentSection,
  query: string,
  speaker: string | null,
): boolean {
  if (section.kind !== "paragraph") return !query && !speaker;
  const words = section.paragraph.blocks.flatMap((block) =>
    block.kind === "utterance"
      ? block.utterance.tokens.flatMap((token) => (token.kind === "word" ? [token.word] : []))
      : [],
  );
  if (speaker && !words.some((word) => word.speakerClusterId === speaker)) return false;
  return !query || words.some((word) => word.text.toLocaleLowerCase().includes(query));
}

const TranscriptWord = memo(function TranscriptWord({
  token,
  selected,
  active,
  color,
  onPointerDown,
  onPointerEnter,
  onContextMenu,
}: {
  token: Extract<TranscriptInlineToken, { kind: "word" }>;
  selected: boolean;
  active: boolean;
  color: string | undefined;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const wordRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) wordRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <>
      {token.word.cutBefore && (
        <span
          className="mx-0.5 inline-block h-3 w-px bg-border-strong align-middle"
          title="Edit point"
        />
      )}
      <span className={cn("relative inline-block", selected && "bg-selection text-primary")}>
        {active && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-px bottom-0.5 top-0.5 z-10 w-0.5 bg-playhead"
          />
        )}
        <button
          ref={wordRef}
          type="button"
          aria-pressed={selected}
          className="px-0.5 py-px text-left leading-7 text-primary outline-none hover:bg-surface/70 focus-visible:bg-surface focus-visible:ring-1 focus-visible:ring-focus"
          style={color ? { color } : undefined}
          onPointerDown={onPointerDown}
          onPointerEnter={onPointerEnter}
          onContextMenu={onContextMenu}
        >
          {token.word.text}
        </button>{" "}
      </span>
    </>
  );
});

function CoverageBlock({
  block,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  block: Extract<TranscriptDocumentBlock, { kind: "coverage" }>;
  actionLabel: string;
  actionDisabled: boolean;
  onAction: () => void;
}) {
  const labels = {
    missing: "Not transcribed",
    queued: "Waiting to transcribe",
    running: "Transcribing",
    failed: "Transcription unavailable",
  } as const;
  return (
    <div className="flex min-w-0 items-center gap-2 py-2.5 text-ui text-muted">
      <div className="flex min-w-0 flex-1 items-center gap-2 border-l-2 border-border-strong pl-3">
        {block.coverage.state === "running" && <LoaderCircle className="animate-spin" size={13} />}
        <span>{labels[block.coverage.state]}</span>
        <span className="hidden text-ui-xs text-muted sm:inline">
          This interval has no editable words yet.
        </span>
        <Button
          className="ml-auto shrink-0"
          size="sm"
          variant="ghost"
          disabled={actionDisabled}
          onClick={onAction}
        >
          {block.coverage.state === "failed" && <RotateCcw size={12} />}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
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
  const allTokens = useMemo(() => selectableTokens(projection.blocks), [projection.blocks]);
  const tokenIndex = useMemo(
    () => new Map(allTokens.map((token, index) => [token.id, index])),
    [allTokens],
  );
  const [query, setQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const transcriptionConsent = useTranscriptionConsent(
    account.user?.id ?? null,
    onRequestTranscripts,
  );

  const speakers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const block of projection.blocks) {
      if (block.kind !== "utterance") continue;
      const id = block.utterance.speakerClusterId ?? "Unknown speaker";
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts].sort(([left], [right]) => left.localeCompare(right));
  }, [projection.blocks]);
  const speakerName = useMemo(
    () =>
      new Map(
        speakers.map(([id], index) => [id, id === "Unknown speaker" ? id : `Speaker ${index + 1}`]),
      ),
    [speakers],
  );
  const speakerColors = useMemo(
    () =>
      new Map(
        speakers.map(
          ([id], index) => [id, SPEAKER_COLORS[index % SPEAKER_COLORS.length]!] as const,
        ),
      ),
    [speakers],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSections = useMemo(
    () => sections.filter((section) => sectionMatches(section, normalizedQuery, speakerFilter)),
    [normalizedQuery, sections, speakerFilter],
  );
  const selectedTokens = useMemo(
    () => allTokens.filter((token) => selection.has(token.id)),
    [allTokens, selection],
  );
  const selectedRanges = useMemo(() => mergeRanges(selectedTokens), [selectedTokens]);
  const selectionStart = selectedRanges[0]?.startUs;
  const selectionEnd = selectedRanges.at(-1)?.endUs;
  const selectionKey = selectedRanges.map((range) => `${range.startUs}:${range.endUs}`).join(",");
  const publishedSelection = useRef<{
    key: string;
    listener: TimelineTranscriptProps["onSelectionChange"];
  } | null>(null);

  useEffect(() => {
    const published = publishedSelection.current;
    if (published?.key === selectionKey && published.listener === onSelectionChange) return;
    publishedSelection.current = { key: selectionKey, listener: onSelectionChange };
    onSelectionChange(selectedRanges);
  }, [onSelectionChange, selectedRanges, selectionKey]);

  useEffect(() => {
    const stopDragging = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stopDragging);
    return () => window.removeEventListener("pointerup", stopDragging);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextMenu]);

  useEffect(() => {
    function deleteSelection(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        isEditableTarget(event.target) ||
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
        if (result.ok) setSelection(new Set());
      });
    }
    window.addEventListener("keydown", deleteSelection);
    return () => window.removeEventListener("keydown", deleteSelection);
  }, [onCommand, selectedRanges, sequenceId]);

  function selectThrough(id: string, extend: boolean): void {
    const index = tokenIndex.get(id);
    if (index === undefined) return;
    const anchor = extend && anchorId ? tokenIndex.get(anchorId) : index;
    if (anchor === undefined) return;
    const low = Math.min(anchor, index);
    const high = Math.max(anchor, index);
    setSelection(new Set(allTokens.slice(low, high + 1).map((token) => token.id)));
    if (!extend) setAnchorId(id);
    const token = allTokens[index];
    if (token) onSeek(token.startUs);
  }

  function openContextMenu(id: string, event: React.MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!selection.has(id)) selectThrough(id, false);
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 230)),
    });
  }

  async function deleteRanges(mode: "ripple" | "lift"): Promise<void> {
    if (!selectedRanges.length) return;
    const result = await onCommand({
      type: "sequence.deleteRanges",
      sequenceId: sequenceId as `sequence_${string}`,
      ranges: selectedRanges,
      mode,
    });
    if (result.ok) {
      setSelection(new Set());
      setAnchorId(null);
      setContextMenu(null);
    }
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-panel"
      aria-label="Timeline transcript"
    >
      <header className="shrink-0 border-b border-border bg-panel px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              size={13}
            />
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search transcript…"
              aria-label="Search transcript"
              className="pl-8"
            />
          </div>
          <Menu>
            <MenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-ui-xs text-secondary hover:bg-surface">
              <User size={13} /> Speakers
              {speakerFilter && <span className="size-1.5 rounded-full bg-accent" />}
            </MenuTrigger>
            <MenuContent align="end" className="w-52">
              <MenuItem onClick={() => setSpeakerFilter(null)}>All speakers</MenuItem>
              {speakers.map(([id, count]) => (
                <MenuItem key={id} onClick={() => setSpeakerFilter(id)}>
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: speakerColors.get(id) }}
                  />
                  <span className="flex-1">{speakerName.get(id)}</span>
                  <span className="text-muted tabular-nums">{count}</span>
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-auto px-4 py-4"
        onContextMenu={(event) => {
          if (!selectedTokens.length) return;
          event.preventDefault();
          setContextMenu({
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 230)),
          });
        }}
      >
        {visibleSections.length === 0 ? (
          <div className="grid h-full min-h-48 place-items-center text-center text-ui text-muted">
            <div>
              <p className="font-medium text-secondary">
                {projection.blocks.length
                  ? "No transcript matches"
                  : "The timeline has no transcript content yet"}
              </p>
              <p className="mt-1 text-ui-xs">
                {speakerFilter || query
                  ? "Clear the search or speaker filter."
                  : "Add audio or video in Media, then transcribe it here."}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {visibleSections.map((section) => {
              if (section.kind === "coverage")
                return (
                  <CoverageBlock
                    key={section.coverage.id}
                    block={section}
                    actionLabel={
                      section.coverage.state === "running" || section.coverage.state === "queued"
                        ? "Cancel"
                        : account.status === "signed-in"
                          ? section.coverage.state === "failed"
                            ? "Retry"
                            : "Transcribe"
                          : "Sign in to transcribe"
                    }
                    actionDisabled={
                      section.coverage.state !== "running" &&
                      section.coverage.state !== "queued" &&
                      (account.status !== "signed-in" || !account.transcription)
                    }
                    onAction={() => {
                      if (
                        section.coverage.state === "running" ||
                        section.coverage.state === "queued"
                      )
                        void onCancelTranscripts([section.coverage.assetId]);
                      else transcriptionConsent.request([section.coverage.assetId]);
                    }}
                  />
                );
              return (
                <p
                  key={section.paragraph.id}
                  className="mx-auto max-w-[96ch] py-1 text-justify text-[15px] leading-8 text-primary"
                >
                  {section.paragraph.blocks.map((block) => {
                    if (block.kind === "timeline-gap") {
                      const selected = selection.has(block.gap.id);
                      return (
                        <button
                          key={block.gap.id}
                          type="button"
                          aria-pressed={selected}
                          aria-label={`Timeline gap, ${formatSeconds(block.gap.timelineEndUs - block.gap.timelineStartUs)}`}
                          title={`Timeline gap · ${formatSeconds(block.gap.timelineEndUs - block.gap.timelineStartUs)}`}
                          className={cn(
                            "mx-1 inline-flex border-0 px-1 py-0.5 align-middle text-ui-xs",
                            selected ? "bg-selection text-primary" : "text-muted hover:bg-surface",
                          )}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            dragging.current = true;
                            selectThrough(block.gap.id, event.shiftKey);
                          }}
                          onPointerEnter={(event) => {
                            if (dragging.current && event.buttons & 1)
                              selectThrough(block.gap.id, true);
                          }}
                          onContextMenu={(event) => openContextMenu(block.gap.id, event)}
                        >
                          •••
                        </button>
                      );
                    }
                    return block.utterance.tokens.map((token) => {
                      const id = token.kind === "word" ? token.word.id : token.id;
                      if (token.kind === "word") {
                        return (
                          <TranscriptWord
                            key={id}
                            token={token}
                            selected={selection.has(id)}
                            active={
                              playheadUs >= token.word.timelineStartUs &&
                              playheadUs < token.word.timelineEndUs
                            }
                            color={
                              token.word.speakerClusterId
                                ? speakerColors.get(token.word.speakerClusterId)
                                : undefined
                            }
                            onPointerDown={(event) => {
                              if (event.button !== 0) return;
                              dragging.current = true;
                              selectThrough(id, event.shiftKey);
                            }}
                            onPointerEnter={(event) => {
                              if (dragging.current && event.buttons & 1) selectThrough(id, true);
                            }}
                            onContextMenu={(event) => openContextMenu(id, event)}
                          />
                        );
                      }
                      const selected = selection.has(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={selected}
                          aria-label={`Silence, ${formatSeconds(token.timelineEndUs - token.timelineStartUs)}`}
                          title={`Silence · ${formatSeconds(token.timelineEndUs - token.timelineStartUs)}`}
                          className={cn(
                            "mx-1 inline-flex border-0 px-1 py-0.5 align-middle text-ui-xs",
                            selected ? "bg-selection text-primary" : "text-muted hover:bg-surface",
                          )}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            dragging.current = true;
                            selectThrough(id, event.shiftKey);
                          }}
                          onPointerEnter={(event) => {
                            if (dragging.current && event.buttons & 1) selectThrough(id, true);
                          }}
                          onContextMenu={(event) => openContextMenu(id, event)}
                        >
                          •••
                        </button>
                      );
                    });
                  })}
                </p>
              );
            })}
          </div>
        )}
      </div>
      {contextMenu && selectedTokens.length > 0 && (
        <div
          className="fixed inset-0 z-[79]"
          onPointerDown={() => setContextMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu(null);
          }}
        >
          <div
            role="menu"
            aria-label="Transcript selection actions"
            className="fixed z-[80] w-56 rounded-xl border border-border-strong bg-panel p-1.5 text-ui text-primary shadow-2xl shadow-black/30"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <p className="px-2.5 py-1.5 text-ui-xs font-medium text-muted">
              Selection · {formatSeconds((selectionEnd ?? 0) - (selectionStart ?? 0))}
            </p>
            <button
              role="menuitem"
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-surface"
              onClick={() => {
                if (selectionStart !== undefined && selectionEnd !== undefined)
                  onPlaySelection(selectionStart, selectionEnd);
                setContextMenu(null);
              }}
            >
              <Play size={14} /> Play selection
            </button>
            <button
              role="menuitem"
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-surface"
              onClick={() => void deleteRanges("ripple")}
            >
              <Trash2 size={14} /> Delete and close gap
            </button>
            <button
              role="menuitem"
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-surface"
              onClick={() => void deleteRanges("lift")}
            >
              <MoveHorizontal size={14} /> Lift and leave gap
            </button>
            <button
              role="menuitem"
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-surface"
              onClick={() => {
                setSelection(new Set());
                setAnchorId(null);
                setContextMenu(null);
              }}
            >
              <X size={14} /> Clear selection
            </button>
          </div>
        </div>
      )}
      {transcriptionConsent.dialog}
    </section>
  );
}

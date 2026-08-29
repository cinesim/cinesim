import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Search, Trash2, User, Play, LoaderCircle, RotateCcw } from "@cinesim/ui";
import {
  Button,
  cn,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  SearchField,
} from "@cinesim/ui";
import type { AssetId, EditorCommand, Project, TimelineRange } from "@cinesim/core";
import type { TranscriptSnapshot } from "../../../shared/transcript";
import {
  projectTimelineTranscript,
  type ProjectedUtterance,
  type TranscriptDocumentBlock,
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

const ROW_ESTIMATE_PX = 112;
const WINDOW_OVERSCAN = 8;

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

function blockMatches(
  block: TranscriptDocumentBlock,
  query: string,
  speaker: string | null,
): boolean {
  if (block.kind !== "utterance") return !query && !speaker;
  if (speaker && block.utterance.speakerClusterId !== speaker) return false;
  if (!query) return true;
  return block.utterance.tokens.some(
    (token) => token.kind === "word" && token.word.text.toLocaleLowerCase().includes(query),
  );
}

const TranscriptWord = memo(function TranscriptWord({
  token,
  selected,
  active,
  onPointerDown,
  onPointerEnter,
}: {
  token: Extract<TranscriptInlineToken, { kind: "word" }>;
  selected: boolean;
  active: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <>
      {token.word.cutBefore && (
        <span
          className="mx-0.5 inline-block h-3 w-px bg-border-strong align-middle"
          title="Edit point"
        />
      )}
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "rounded-sm px-0.5 py-px text-left leading-7 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
          selected
            ? "bg-accent/25 text-primary"
            : active
              ? "bg-surface text-primary"
              : "text-primary hover:bg-surface",
        )}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
      >
        {token.word.text}
      </button>{" "}
    </>
  );
});

function SpeakerMenu({
  speaker,
  count,
  active,
  onFilter,
  onSelectUtterance,
}: {
  speaker: string;
  count: number;
  active: boolean;
  onFilter: () => void;
  onSelectUtterance: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          "inline-flex h-6 items-center rounded-full border px-2 text-ui-xs font-semibold",
          active
            ? "border-accent bg-accent/15 text-primary"
            : "border-border bg-panel text-secondary hover:bg-surface",
        )}
        aria-label={`Actions for ${speaker}`}
      >
        {speaker}
      </MenuTrigger>
      <MenuContent align="start" className="w-52">
        <MenuLabel>
          {count} utterance{count === 1 ? "" : "s"}
        </MenuLabel>
        <MenuItem onClick={onFilter}>
          {active ? "Show all speakers" : `Filter to ${speaker}`}
        </MenuItem>
        <MenuItem onClick={onSelectUtterance}>Select this utterance</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function CoverageBlock({
  block,
}: {
  block: Extract<TranscriptDocumentBlock, { kind: "coverage" }>;
}) {
  const labels = {
    missing: "Not transcribed",
    queued: "Waiting to transcribe",
    running: "Transcribing",
    failed: "Transcription unavailable",
  } as const;
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-panel-muted px-3 py-3 text-ui text-muted">
      <span className="inline-flex items-center gap-2 font-medium text-secondary">
        {block.coverage.state === "running" && <LoaderCircle className="animate-spin" size={13} />}
        {labels[block.coverage.state]}
      </span>
      <p className="mt-1 text-ui-xs">
        This timeline interval is shown explicitly so transcript coverage is never implied.
      </p>
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
  const allTokens = useMemo(() => selectableTokens(projection.blocks), [projection.blocks]);
  const tokenIndex = useMemo(
    () => new Map(allTokens.map((token, index) => [token.id, index])),
    [allTokens],
  );
  const [query, setQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const dragging = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const viewportRef = useRef<HTMLDivElement>(null);
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
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleBlocks = useMemo(
    () => projection.blocks.filter((block) => blockMatches(block, normalizedQuery, speakerFilter)),
    [normalizedQuery, projection.blocks, speakerFilter],
  );
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_ESTIMATE_PX) - WINDOW_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_ESTIMATE_PX) + WINDOW_OVERSCAN * 2;
  const lastVisible = Math.min(visibleBlocks.length, firstVisible + visibleCount);
  const renderedBlocks = visibleBlocks.slice(firstVisible, lastVisible);
  const selectedTokens = useMemo(
    () => allTokens.filter((token) => selection.has(token.id)),
    [allTokens, selection],
  );
  const selectedRanges = useMemo(() => mergeRanges(selectedTokens), [selectedTokens]);
  const selectionStart = selectedRanges[0]?.startUs;
  const selectionEnd = selectedRanges.at(-1)?.endUs;
  const missingAssetIds = useMemo(
    () => [...new Set(projection.coverage.map((item) => item.assetId))],
    [projection.coverage],
  );
  const activeAssetIds = useMemo(
    () =>
      projection.coverage
        .filter((item) => item.state === "queued" || item.state === "running")
        .map((item) => item.assetId),
    [projection.coverage],
  );
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
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setViewportHeight(viewport.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stopDragging = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stopDragging);
    return () => window.removeEventListener("pointerup", stopDragging);
  }, []);

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

  function selectUtterance(utterance: ProjectedUtterance): void {
    const ids = utterance.tokens.map((token) => (token.kind === "word" ? token.word.id : token.id));
    setSelection(new Set(ids));
    setAnchorId(ids[0] ?? null);
    onSeek(utterance.timelineStartUs);
  }

  async function deleteRanges(mode: "ripple" | "lift"): Promise<void> {
    if (!selectedRanges.length) return;
    const result = await onCommand({
      type: "sequence.deleteRanges",
      sequenceId: sequenceId as `sequence_${string}`,
      ranges: selectedRanges,
      mode,
    });
    if (result.ok) setSelection(new Set());
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Timeline transcript">
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
                  <span className="flex-1">{speakerName.get(id)}</span>
                  <span className="text-muted tabular-nums">{count}</span>
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
        <div className="mt-2 flex min-h-7 items-center gap-2 text-ui-xs">
          {selectedTokens.length > 0 ? (
            <>
              <span className="font-medium text-primary">
                {selectedTokens.length === 1
                  ? selectedTokens[0]?.label
                  : `${selectedTokens.length} items`}{" "}
                · {formatSeconds((selectionEnd ?? 0) - (selectionStart ?? 0))}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  selectionStart !== undefined &&
                  selectionEnd !== undefined &&
                  onPlaySelection(selectionStart, selectionEnd)
                }
              >
                <Play size={12} /> Play
              </Button>
              {activeAssetIds.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void onCancelTranscripts(activeAssetIds)}
                >
                  Cancel
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={() => void deleteRanges("ripple")}>
                <Trash2 size={12} /> Ripple delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void deleteRanges("lift")}>
                Lift
              </Button>
            </>
          ) : missingAssetIds.length > 0 ? (
            <>
              <span className="text-muted">
                {projection.coverage.some((item) => item.state === "running")
                  ? "Building transcript with Deepgram Nova-3…"
                  : `${missingAssetIds.length} source${missingAssetIds.length === 1 ? "" : "s"} need transcription`}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  account.status !== "signed-in" ||
                  !account.transcription ||
                  projection.coverage.some((item) => item.state === "running")
                }
                onClick={() => transcriptionConsent.request(missingAssetIds)}
              >
                {projection.coverage.some((item) => item.state === "failed") ? (
                  <RotateCcw size={12} />
                ) : null}
                {account.status === "signed-in" ? "Transcribe timeline" : "Sign in to transcribe"}
              </Button>
            </>
          ) : (
            <span className="text-muted">Click or drag words to select exact timeline ranges.</span>
          )}
        </div>
      </header>

      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto px-4 py-4"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {visibleBlocks.length === 0 ? (
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
          <div>
            <div style={{ height: firstVisible * ROW_ESTIMATE_PX }} aria-hidden="true" />
            <div className="space-y-3">
              {renderedBlocks.map((block) => {
                if (block.kind === "coverage")
                  return <CoverageBlock key={block.coverage.id} block={block} />;
                if (block.kind === "timeline-gap") {
                  const selected = selection.has(block.gap.id);
                  return (
                    <button
                      key={block.gap.id}
                      type="button"
                      aria-pressed={selected}
                      aria-label={`Timeline gap, ${formatSeconds(block.gap.timelineEndUs - block.gap.timelineStartUs)}`}
                      className={cn(
                        "rounded-full border border-dashed px-3 py-1 text-ui-xs",
                        selected
                          ? "border-accent bg-accent/15 text-primary"
                          : "border-border-strong text-muted hover:bg-surface",
                      )}
                      onClick={(event) => selectThrough(block.gap.id, event.shiftKey)}
                    >
                      ◦◦◦ timeline gap ·{" "}
                      {formatSeconds(block.gap.timelineEndUs - block.gap.timelineStartUs)}
                    </button>
                  );
                }
                const utterance = block.utterance;
                const speakerId = utterance.speakerClusterId ?? "Unknown speaker";
                const count = speakers.find(([id]) => id === speakerId)?.[1] ?? 1;
                return (
                  <article
                    key={utterance.id}
                    className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 rounded-lg px-1 py-2 hover:bg-panel-muted"
                  >
                    <div>
                      <SpeakerMenu
                        speaker={speakerName.get(speakerId) ?? speakerId}
                        count={count}
                        active={speakerFilter === speakerId}
                        onFilter={() =>
                          setSpeakerFilter((current) => (current === speakerId ? null : speakerId))
                        }
                        onSelectUtterance={() => selectUtterance(utterance)}
                      />
                      {utterance.overlapping && (
                        <p className="mt-1 text-[9px] font-semibold uppercase tracking-wide text-muted">
                          Overlap
                        </p>
                      )}
                    </div>
                    <p className="text-[15px] leading-7 text-primary">
                      {utterance.tokens.map((token) => {
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
                              onPointerDown={(event) => {
                                if (event.button !== 0) return;
                                dragging.current = true;
                                selectThrough(id, event.shiftKey);
                              }}
                              onPointerEnter={(event) => {
                                if (dragging.current && event.buttons & 1) selectThrough(id, true);
                              }}
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
                              "mx-1 inline-flex rounded-full border px-2 py-0.5 align-middle text-ui-xs",
                              selected
                                ? "border-accent bg-accent/20 text-primary"
                                : "border-border bg-panel-muted text-muted hover:bg-surface",
                            )}
                            onPointerDown={(event) => {
                              dragging.current = true;
                              selectThrough(id, event.shiftKey);
                            }}
                            onPointerEnter={(event) => {
                              if (dragging.current && event.buttons & 1) selectThrough(id, true);
                            }}
                          >
                            ••• {formatSeconds(token.timelineEndUs - token.timelineStartUs)}
                          </button>
                        );
                      })}
                    </p>
                  </article>
                );
              })}
            </div>
            <div
              style={{ height: Math.max(0, visibleBlocks.length - lastVisible) * ROW_ESTIMATE_PX }}
              aria-hidden="true"
            />
          </div>
        )}
      </div>
      {transcriptionConsent.dialog}
    </section>
  );
}

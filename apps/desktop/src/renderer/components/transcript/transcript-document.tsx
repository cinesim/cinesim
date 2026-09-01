import { memo, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { LoaderCircle, RotateCcw } from "@cinesim/ui";
import { Button, cn } from "@cinesim/ui";
import type { AssetId, TimeUs } from "@cinesim/core";
import type { VisualIndexObservation } from "@cinesim/project-io";
import type { ScreenplayEntry } from "../../../shared/screenplay";
import type {
  TranscriptDocumentBlock,
  TranscriptDocumentSection,
  TranscriptInlineToken,
} from "../../../shared/transcript";
import { formatTranscriptDuration } from "./transcript-selection";

interface TranscriptDocumentSelection {
  begin: (id: string, event: PointerEvent<HTMLButtonElement>) => void;
  enter: (id: string, event: PointerEvent<HTMLButtonElement>) => void;
  selectedIds: ReadonlySet<string>;
}

interface TranscriptDocumentProps {
  canTranscribe: boolean;
  hasFilters: boolean;
  hasTranscriptContent: boolean;
  onCancelTranscript: (assetId: AssetId) => void;
  onRequestTranscript: (assetId: AssetId) => void;
  playheadUs: TimeUs;
  sections: readonly TranscriptDocumentSection[];
  selection: TranscriptDocumentSelection;
  signedIn: boolean;
  speakerColors: ReadonlyMap<string, string>;
  screenplay?: ScreenplayDocumentModel;
}

interface ScreenplayDocumentModel {
  entries: readonly ScreenplayEntry[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string, startUs: number, endUs: number) => void;
  onCorrect: (assetId: string, observation: VisualIndexObservation, description: string) => void;
  onSplit: (assetId: string, observation: VisualIndexObservation) => void;
  onMergeNext: (assetId: string, observation: VisualIndexObservation) => void;
  onGenerate: (assetId: string, force: boolean) => void;
  onClear: (assetId: string) => void;
}

const TranscriptWord = memo(function TranscriptWord({
  token,
  selected,
  active,
  color,
  onPointerDown,
  onPointerEnter,
}: {
  token: Extract<TranscriptInlineToken, { kind: "word" }>;
  selected: boolean;
  active: boolean;
  color: string | undefined;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => void;
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
          data-transcript-token-id={token.word.id}
          aria-pressed={selected}
          className="px-0.5 py-px text-left leading-7 text-primary outline-none hover:bg-surface/70 focus-visible:bg-surface focus-visible:ring-1 focus-visible:ring-focus"
          style={color ? { color } : undefined}
          onPointerDown={onPointerDown}
          onPointerEnter={onPointerEnter}
        >
          {token.word.text}
        </button>{" "}
      </span>
    </>
  );
});

function TranscriptMarker({
  durationUs,
  id,
  label,
  selection,
}: {
  durationUs: number;
  id: string;
  label: string;
  selection: TranscriptDocumentSelection;
}) {
  const selected = selection.selectedIds.has(id);
  const duration = formatTranscriptDuration(durationUs);
  return (
    <button
      type="button"
      data-transcript-token-id={id}
      aria-pressed={selected}
      aria-label={`${label}, ${duration}`}
      title={`${label} · ${duration}`}
      className={cn(
        "mx-1 inline-flex border-0 px-1 py-0.5 align-middle text-ui-xs",
        selected ? "bg-selection text-primary" : "text-muted hover:bg-surface",
      )}
      onPointerDown={(event) => selection.begin(id, event)}
      onPointerEnter={(event) => selection.enter(id, event)}
    >
      •••
    </button>
  );
}

function CoverageRow({
  block,
  canTranscribe,
  onCancel,
  onRequest,
  signedIn,
}: {
  block: Extract<TranscriptDocumentBlock, { kind: "coverage" }>;
  canTranscribe: boolean;
  onCancel: () => void;
  onRequest: () => void;
  signedIn: boolean;
}) {
  const labels = {
    missing: "Not transcribed",
    queued: "Waiting to transcribe",
    running: "Transcribing",
    failed: "Transcription unavailable",
  } as const;
  const pending = block.coverage.state === "running" || block.coverage.state === "queued";
  const actionLabel = pending
    ? "Cancel"
    : signedIn
      ? block.coverage.state === "failed"
        ? "Retry"
        : "Transcribe"
      : "Sign in to transcribe";

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
          disabled={!pending && !canTranscribe}
          onClick={pending ? onCancel : onRequest}
        >
          {block.coverage.state === "failed" && <RotateCcw size={12} />}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function sectionStart(section: TranscriptDocumentSection): number {
  if (section.kind === "coverage") return section.coverage.timelineStartUs;
  const block = section.paragraph.blocks[0];
  if (!block) return Number.MAX_SAFE_INTEGER;
  return block.kind === "timeline-gap"
    ? block.gap.timelineStartUs
    : block.utterance.timelineStartUs;
}

function DialogueParagraph({
  section,
  playheadUs,
  selection,
  speakerColors,
}: {
  section: Extract<TranscriptDocumentSection, { kind: "paragraph" }>;
  playheadUs: TimeUs;
  selection: TranscriptDocumentSelection;
  speakerColors: ReadonlyMap<string, string>;
}) {
  return (
    <div className="space-y-3 py-2">
      {section.paragraph.blocks.map((block) => {
        if (block.kind === "timeline-gap")
          return (
            <div key={block.gap.id} className="text-center">
              <TranscriptMarker
                id={block.gap.id}
                label="Timeline gap"
                durationUs={block.gap.timelineEndUs - block.gap.timelineStartUs}
                selection={selection}
              />
            </div>
          );
        return (
          <div key={block.utterance.id} className="mx-auto max-w-[42ch] text-center">
            <p
              className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-muted"
              style={
                block.utterance.speakerClusterId
                  ? { color: speakerColors.get(block.utterance.speakerClusterId) }
                  : undefined
              }
            >
              {block.utterance.speakerClusterId ?? "Dialogue"}
            </p>
            <p className="transcript-document text-[15px] leading-8 text-primary">
              {block.utterance.tokens.map((token) => {
                const id = token.kind === "word" ? token.word.id : token.id;
                if (token.kind === "media-silence")
                  return (
                    <TranscriptMarker
                      key={id}
                      id={id}
                      label="Silence"
                      durationUs={token.timelineEndUs - token.timelineStartUs}
                      selection={selection}
                    />
                  );
                return (
                  <TranscriptWord
                    key={id}
                    token={token}
                    selected={selection.selectedIds.has(id)}
                    active={
                      playheadUs >= token.word.timelineStartUs &&
                      playheadUs < token.word.timelineEndUs
                    }
                    color={
                      token.word.speakerClusterId
                        ? speakerColors.get(token.word.speakerClusterId)
                        : undefined
                    }
                    onPointerDown={(event) => selection.begin(id, event)}
                    onPointerEnter={(event) => selection.enter(id, event)}
                  />
                );
              })}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function ActionBlock({
  entry,
  model,
}: {
  entry: Extract<ScreenplayEntry, { kind: "action" }>;
  model: ScreenplayDocumentModel;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.observation.description);
  const selected = model.selectedId === entry.id;
  return (
    <div
      className={cn(
        "mx-auto max-w-[58ch] rounded px-3 py-2 text-left outline-none",
        selected ? "bg-selection ring-1 ring-focus" : "hover:bg-surface/55",
      )}
    >
      <button
        type="button"
        className="block w-full text-left outline-none"
        onClick={() => model.onSelect(entry.id, entry.timelineStartUs, entry.timelineEndUs)}
      >
        <span className="block text-[9px] font-bold uppercase tracking-[0.14em] text-disabled">
          Action · {entry.assetName}
        </span>
        {!editing && (
          <span className="mt-1 block text-[13px] leading-6 text-secondary">
            {entry.observation.description}
          </span>
        )}
      </button>
      {editing ? (
        <textarea
          aria-label="Visual observation description"
          className="mt-1 min-h-20 w-full resize-y rounded border border-border bg-panel-muted p-2 text-ui text-primary outline-none focus:border-focus"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-1 text-[9px] text-muted">
        {entry.observation.shotType && <span>{entry.observation.shotType}</span>}
        {entry.observation.setting && <span>· {entry.observation.setting}</span>}
        {entry.observation.people?.length ? (
          <span>· {entry.observation.people.join(", ")}</span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(entry.observation.description);
            setEditing((value) => !value);
          }}
        >
          {editing ? "Cancel" : "Correct"}
        </Button>
        {editing && (
          <Button
            size="sm"
            disabled={!draft.trim()}
            onClick={() => {
              model.onCorrect(entry.assetId, entry.observation, draft);
              setEditing(false);
            }}
          >
            Save
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => model.onSplit(entry.assetId, entry.observation)}
        >
          Split
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => model.onMergeNext(entry.assetId, entry.observation)}
        >
          Merge next
        </Button>
        <Button size="sm" variant="ghost" onClick={() => model.onClear(entry.assetId)}>
          Clear index
        </Button>
      </div>
    </div>
  );
}

function ScreenplayEntryView({
  entry,
  model,
}: {
  entry: ScreenplayEntry;
  model: ScreenplayDocumentModel;
}) {
  if (entry.kind === "action") return <ActionBlock entry={entry} model={model} />;
  if (entry.kind === "scene")
    return (
      <div className="mx-auto max-w-[64ch] border-y border-border/70 py-2 text-center text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
        {entry.title}
      </div>
    );
  if (entry.kind === "support")
    return (
      <button
        type="button"
        className={cn(
          "mx-auto flex max-w-[52ch] items-center rounded-full border border-border px-2.5 py-1 text-[10px] text-muted hover:bg-surface",
          model.selectedId === entry.id && "border-focus bg-selection text-primary",
        )}
        onClick={() => model.onSelect(entry.id, entry.timelineStartUs, entry.timelineEndUs)}
      >
        {entry.media === "audio" ? "♪" : "▣"} {entry.label}
      </button>
    );
  return (
    <div
      className={cn(
        "mx-auto flex max-w-[58ch] items-center gap-2 rounded border border-dashed border-border-strong px-3 py-2 text-ui-xs text-muted",
        model.selectedId === entry.id && "border-focus bg-selection text-primary",
      )}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left outline-none"
        onClick={() => model.onSelect(entry.id, entry.timelineStartUs, entry.timelineEndUs)}
      >
        Visual coverage {entry.state} · {entry.assetName}
      </button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => model.onGenerate(entry.assetId, entry.state !== "missing")}
      >
        {entry.state === "missing" ? "Initialize" : "Reset"}
      </Button>
    </div>
  );
}

export function TranscriptDocument({
  canTranscribe,
  hasFilters,
  hasTranscriptContent,
  onCancelTranscript,
  onRequestTranscript,
  playheadUs,
  sections,
  selection,
  signedIn,
  speakerColors,
  screenplay,
}: TranscriptDocumentProps) {
  if (sections.length === 0 && !screenplay?.entries.length)
    return (
      <div className="grid h-full min-h-48 place-items-center text-center text-ui text-muted">
        <div>
          <p className="font-medium text-secondary">
            {hasTranscriptContent
              ? "No transcript matches"
              : "The timeline has no transcript content yet"}
          </p>
          <p className="mt-1 text-ui-xs">
            {hasFilters
              ? "Clear the search or speaker filter."
              : "Add audio or video in Media, then transcribe it here."}
          </p>
        </div>
      </div>
    );

  const items = [
    ...sections.map((section) => ({
      kind: "transcript" as const,
      atUs: sectionStart(section),
      section,
    })),
    ...(screenplay?.entries.map((entry) => ({
      kind: "screenplay" as const,
      atUs: entry.timelineStartUs,
      entry,
    })) ?? []),
  ].sort((left, right) => left.atUs - right.atUs);

  return (
    <div className="space-y-3 font-mono">
      {screenplay?.loading && (
        <p className="text-center text-ui-xs text-muted">Loading visual index…</p>
      )}
      {screenplay?.error && (
        <p className="text-center text-ui-xs text-danger">
          Visual index unavailable · {screenplay.error}
        </p>
      )}
      {items.map((item) => {
        if (item.kind === "screenplay")
          return (
            <ScreenplayEntryView
              key={`screenplay:${item.entry.id}`}
              entry={item.entry}
              model={screenplay!}
            />
          );
        const section = item.section;
        if (section.kind === "coverage")
          return (
            <CoverageRow
              key={section.coverage.id}
              block={section}
              canTranscribe={canTranscribe}
              signedIn={signedIn}
              onCancel={() => onCancelTranscript(section.coverage.assetId)}
              onRequest={() => onRequestTranscript(section.coverage.assetId)}
            />
          );
        return (
          <DialogueParagraph
            key={section.paragraph.id}
            section={section}
            playheadUs={playheadUs}
            selection={selection}
            speakerColors={speakerColors}
          />
        );
      })}
    </div>
  );
}

import { memo, useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import { LoaderCircle, RotateCcw } from "@cinesim/ui";
import { Button, cn } from "@cinesim/ui";
import type { AssetId, TimeUs } from "@cinesim/core";
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
}: TranscriptDocumentProps) {
  if (sections.length === 0)
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

  return (
    <div className="space-y-4">
      {sections.map((section) => {
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
          <p
            key={section.paragraph.id}
            className="transcript-document mx-auto max-w-[64ch] py-1 text-center text-[15px] leading-8 text-primary"
          >
            {section.paragraph.blocks.map((block) => {
              if (block.kind === "timeline-gap")
                return (
                  <TranscriptMarker
                    key={block.gap.id}
                    id={block.gap.id}
                    label="Timeline gap"
                    durationUs={block.gap.timelineEndUs - block.gap.timelineStartUs}
                    selection={selection}
                  />
                );
              return block.utterance.tokens.map((token) => {
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
              });
            })}
          </p>
        );
      })}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Cloud, Film, Plus, RotateCcw, Sparkles, X } from "@cinesim/ui";
import {
  Button,
  cn,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
  PaneHeader,
  PreviewCard,
  SearchField,
} from "@cinesim/ui";
import type { Asset, Project } from "@cinesim/core";
import type { TranscriptAssetSnapshot } from "../../../shared/transcript";
import { formatDuration } from "../../lib/format";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorDnd } from "../workspace/editor-dnd-context";
import { useEditorTransport } from "../workspace/editor-transport-context";
import { AssetSourceMetadata } from "./asset-source-metadata";
import { MediaSkimSurface } from "./media-skim-surface";

interface EditMediaPoolProps {
  project: Project;
  sequenceId: string;
}

const transcriptLabels = {
  missing: "Not transcribed",
  queued: "Transcript queued",
  running: "Transcribing",
  ready: "Transcript ready",
  failed: "Transcript failed",
} as const;

function transcriptStatusClass(state: keyof typeof transcriptLabels): string {
  if (state === "ready") return "bg-accent";
  if (state === "failed") return "bg-primary";
  return state === "queued" || state === "running"
    ? "animate-pulse bg-primary"
    : "bg-border-strong";
}

function TranscriptAction({
  asset,
  available,
  onCancel,
  onRequest,
  state,
}: {
  asset: Asset;
  available: boolean;
  onCancel: () => Promise<unknown>;
  onRequest: () => void;
  state: keyof typeof transcriptLabels;
}) {
  if (state === "queued" || state === "running") {
    return (
      <button
        type="button"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-secondary hover:bg-surface hover:text-primary"
        aria-label={`Cancel transcript for ${asset.name}`}
        title="Cancel transcription"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void onCancel();
        }}
      >
        <X size={11} />
      </button>
    );
  }
  if (state !== "missing" && state !== "failed") return null;
  const action = state === "failed" ? "Retry" : "Generate";
  return (
    <button
      type="button"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-secondary hover:bg-surface hover:text-primary disabled:opacity-40"
      aria-label={`${action} transcript for ${asset.name}`}
      title={available ? `${action} transcript` : "Sign in to transcribe"}
      disabled={!available}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onRequest();
      }}
    >
      {state === "failed" ? <RotateCcw size={11} /> : <Sparkles size={11} />}
    </button>
  );
}

function TranscriptStatus({
  asset,
  available,
  onCancel,
  onRequest,
  transcript,
}: {
  asset: Asset;
  available: boolean;
  onCancel: () => Promise<unknown>;
  onRequest: () => void;
  transcript: TranscriptAssetSnapshot | undefined;
}) {
  const supported = asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio === true);
  if (!supported) return null;
  const state = transcript?.state ?? "missing";
  const progress =
    state === "running" && transcript?.progress !== undefined
      ? ` · ${Math.round(transcript.progress * 100)}%`
      : "";
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px]">
      <span className={cn("size-1.5 shrink-0 rounded-full", transcriptStatusClass(state))} />
      <span className="min-w-0 flex-1 truncate text-muted">
        {transcriptLabels[state]}
        {progress}
      </span>
      <TranscriptAction
        asset={asset}
        available={available}
        onCancel={onCancel}
        onRequest={onRequest}
        state={state}
      />
    </div>
  );
}

export function EditMediaPool({ project, sequenceId }: EditMediaPoolProps) {
  const [query, setQuery] = useState("");
  const appendAsset = useRendererStore((state) => state.appendAsset);
  const importMedia = useRendererStore((state) => state.importMedia);
  const transcripts = useRendererStore((state) => state.transcripts);
  const account = useRendererStore((state) => state.account);
  const requestTranscripts = useRendererStore((state) => state.requestTranscripts);
  const cancelTranscripts = useRendererStore((state) => state.cancelTranscripts);
  const normalizedQuery = query.trim().toLowerCase();
  const assets = useMemo(
    () => project.assets.filter((asset) => asset.name.toLowerCase().includes(normalizedQuery)),
    [normalizedQuery, project.assets],
  );

  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel">
      <PaneHeader size="sm" className="border-b-0">
        <SearchField
          size="sm"
          surface="muted"
          placeholder="Search media"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </PaneHeader>

      <div className="edit-media-pool-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {assets.length > 0 ? (
          <div className="edit-media-pool-grid">
            {assets.map((asset) => (
              <DraggableAssetCard
                key={asset.id}
                asset={asset}
                transcript={transcripts?.assets[asset.id]}
                transcriptionAvailable={account.status === "signed-in" && account.transcription}
                onRequestTranscript={() => void requestTranscripts([asset.id])}
                onCancelTranscript={() => cancelTranscripts([asset.id])}
                onAddAsset={(asset) => appendAsset(asset.id, sequenceId)}
              />
            ))}
          </div>
        ) : normalizedQuery ? (
          <p className="px-2 py-8 text-center text-ui-xs text-muted">Nothing matches “{query}”.</p>
        ) : (
          <Empty className="px-2 py-8">
            <EmptyHeader>
              <EmptyIcon className="mb-2">
                <Film size={21} />
              </EmptyIcon>
              <EmptyTitle>No media yet</EmptyTitle>
              <EmptyDescription>Import media to start assembling this cut.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>

      <div className="p-2">
        <Button className="w-full" variant="secondary" onClick={() => void importMedia()}>
          Import media
        </Button>
      </div>
    </aside>
  );
}

function DraggableAssetCard({
  asset,
  transcript,
  transcriptionAvailable,
  onRequestTranscript,
  onCancelTranscript,
  onAddAsset,
}: {
  asset: Asset;
  transcript: TranscriptAssetSnapshot | undefined;
  transcriptionAvailable: boolean;
  onRequestTranscript: () => void;
  onCancelTranscript: () => Promise<unknown>;
  onAddAsset: (asset: Asset) => Promise<unknown>;
}) {
  const editorDrag = useEditorDnd();
  const transport = useEditorTransport();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `asset:${asset.id}`,
    data: { kind: "asset", assetId: asset.id },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={isDragging ? "opacity-45" : undefined}
    >
      <PreviewCard
        ariaLabel={`Add ${asset.name} to the active timeline`}
        title="Double-click to add to the active timeline"
        size="compact"
        previewClassName="media-thumbnail"
        preview={
          <MediaSkimSurface
            asset={asset}
            disabled={editorDrag.dragging}
            onPreviewTime={(sourceTimeUs) => transport.previewAsset(asset.id, sourceTimeUs)}
            onPreviewEnd={() => void transport.exitAssetPreview()}
          />
        }
        bottomCorner={
          <div className="flex items-center gap-1">
            {asset.source.kind === "cloud" && (
              <span
                className="grid size-5 place-items-center rounded bg-panel/90 text-secondary"
                title="Cloud original"
              >
                <Cloud size={10} />
              </span>
            )}
            <span className="rounded bg-panel/90 px-1 py-0.5 text-[10px] tabular-nums text-secondary">
              {formatDuration(asset.durationUs)}
            </span>
          </div>
        }
        action={
          <Button
            className="opacity-80 transition-opacity hover:opacity-100"
            size="icon"
            variant="ghost"
            aria-label={`Add ${asset.name} to the active timeline`}
            title="Add to active timeline"
            onClick={() => void onAddAsset(asset)}
          >
            <Plus size={13} />
          </Button>
        }
        onDoubleClick={() => void onAddAsset(asset)}
      >
        <p className="truncate text-ui-xs font-medium text-primary" title={asset.name}>
          {asset.name}
        </p>
        <p className="edit-media-card-secondary mt-0.5 truncate text-[10px] text-muted tabular-nums">
          {asset.id}
        </p>
        <AssetSourceMetadata
          asset={asset}
          className="edit-media-card-secondary mt-0.5 truncate text-[10px] text-muted tabular-nums"
        />
        <TranscriptStatus
          asset={asset}
          available={transcriptionAvailable}
          onCancel={onCancelTranscript}
          onRequest={onRequestTranscript}
          transcript={transcript}
        />
      </PreviewCard>
    </div>
  );
}

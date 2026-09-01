import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Film, Plus } from "@cinesim/ui";
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
  PaneHeader,
  SearchField,
} from "@cinesim/ui";
import type { Asset, Project } from "@cinesim/core";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorDnd } from "../workspace/editor-dnd-context";
import { useEditorTransport } from "../workspace/editor-transport-context";
import { assetNeedsEditProxy, retryableAssetId, transcriptActionFor } from "./media-actions";
import { MediaAssetCard } from "./media-asset-presentation";
import { MediaAssetContextMenu } from "./media-bin-context-menu";
import { assetStoragePresentation } from "./media-bin-model";

interface EditMediaPoolProps {
  project: Project;
  sequenceId: string;
}

export function EditMediaPool({ project, sequenceId }: EditMediaPoolProps) {
  const [query, setQuery] = useState("");
  const appendAsset = useRendererStore((state) => state.appendAsset);
  const importMedia = useRendererStore((state) => state.importMedia);
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
  onAddAsset,
}: {
  asset: Asset;
  onAddAsset: (asset: Asset) => Promise<unknown>;
}) {
  const editorDrag = useEditorDnd();
  const transport = useEditorTransport();
  const cloudTransfers = useRendererStore((state) => state.cloudTransfers);
  const derivedMedia = useRendererStore((state) => state.derivedMedia);
  const transcripts = useRendererStore((state) => state.transcripts);
  const account = useRendererStore((state) => state.account);
  const requestTranscripts = useRendererStore((state) => state.requestTranscripts);
  const regenerateTranscripts = useRendererStore((state) => state.regenerateTranscripts);
  const cancelTranscripts = useRendererStore((state) => state.cancelTranscripts);
  const downloadedCloudOriginals = useRendererStore((state) => state.downloadedCloudOriginals);
  const retryCloudTransfer = useRendererStore((state) => state.retryCloudTransfer);
  const keepCloudOriginalDownloaded = useRendererStore(
    (state) => state.keepCloudOriginalDownloaded,
  );
  const removeCloudOriginalDownload = useRendererStore(
    (state) => state.removeCloudOriginalDownload,
  );
  const derivedScope = useRendererStore((state) =>
    state.project.status === "ready" ? state.project.session.derivedScope : null,
  );
  const transfer = cloudTransfers.find((candidate) => candidate.assetId === asset.id);
  const cloudDownloaded = downloadedCloudOriginals.includes(asset.id);
  const storage = assetStoragePresentation(asset, transfer, cloudDownloaded);
  const transcriptAsset = asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio);
  const transcriptAction = transcriptActionFor(transcriptAsset ? [asset] : [], transcripts);
  const needsProxy = assetNeedsEditProxy(asset, derivedMedia?.assets[asset.id]);
  const retryAssetId = retryableAssetId(asset, transfer);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `asset:${asset.id}`,
    data: { kind: "asset", assetId: asset.id },
  });

  function runTranscriptAction() {
    if (transcriptAction === "cancel") void cancelTranscripts([asset.id]);
    else if (transcriptAction === "regenerate") void regenerateTranscripts([asset.id]);
    else if (transcriptAction === "generate") void requestTranscripts([asset.id]);
  }

  function toggleCloudOriginal() {
    if (cloudDownloaded) void removeCloudOriginalDownload(asset.id);
    else void keepCloudOriginalDownloaded(asset.id);
  }

  return (
    <MediaAssetContextMenu
      canRevealAsset={asset.source.kind === "local"}
      cloudAssetId={asset.source.kind === "cloud" ? asset.id : null}
      cloudOriginalDownloaded={cloudDownloaded}
      hasProxyAssets={needsProxy}
      retryAssetId={retryAssetId}
      selectedCount={1}
      timelineActionLabel="Add to active timeline"
      transcriptAction={transcriptAction}
      transcriptionAvailable={account.status === "signed-in" && account.transcription}
      onCreateTimeline={() => void onAddAsset(asset)}
      onGenerateProxies={() => {
        if (derivedScope) void window.cinesim.derived.requestProxies(derivedScope, [asset.id]);
      }}
      onRetryCloudTransfer={(assetId) => void retryCloudTransfer(assetId)}
      onRevealAsset={() => {
        void window.cinesim.project.revealAsset(asset.id).catch(() => undefined);
      }}
      onToggleCloudOriginal={toggleCloudOriginal}
      onTranscriptAction={runTranscriptAction}
    >
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        className={isDragging ? "opacity-45" : undefined}
      >
        <MediaAssetCard
          asset={asset}
          compact
          storage={storage}
          {...(transfer?.error ? { storageDetail: transfer.error } : {})}
          previewDisabled={editorDrag.dragging}
          onPreviewTime={(sourceTimeUs) => transport.previewAsset(asset.id, sourceTimeUs)}
          onPreviewEnd={() => void transport.exitAssetPreview()}
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
        />
      </div>
    </MediaAssetContextMenu>
  );
}

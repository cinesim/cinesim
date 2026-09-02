import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "@cinesim/ui";
import { Button, Kbd, SearchField } from "@cinesim/ui";
import type { Asset, AssetId, Project, Sequence } from "@cinesim/core";
import { useRendererStore } from "../../store/renderer-store-context";
import { LibraryToolbar, LibraryViewToggle, useLibraryView } from "../shared/library-card";
import { assetNeedsEditProxy, retryableAssetId, transcriptActionFor } from "./media-actions";
import { MediaBinContextMenu } from "./media-bin-context-menu";
import { MediaBinDialogs } from "./media-bin-dialogs";
import type { MediaBinDialog } from "./media-bin-dialogs";
import { MediaBinGrid } from "./media-bin-grid";
import { MediaBinList } from "./media-bin-list";
import { nextTimelineName, summarizeAssetUsage } from "./media-bin-model";
import { useMediaBinSelection } from "./use-media-bin-selection";

interface MediaBinProps {
  project: Project;
  onOpenTimeline: (sequenceId: string) => void;
}

export function MediaBin({ project, onOpenTimeline }: MediaBinProps) {
  const [query, setQuery] = useState("");
  const [view, setView] = useLibraryView("cinesim.media.view");
  const [dialog, setDialog] = useState<MediaBinDialog | null>(null);
  const [timelineName, setTimelineName] = useState("");
  const modifier = window.cinesim.platform === "darwin" ? "⌘" : "Ctrl+";
  const normalizedQuery = query.trim().toLowerCase();
  const sequences = useMemo(
    () =>
      project.sequences.filter((sequence) => sequence.name.toLowerCase().includes(normalizedQuery)),
    [normalizedQuery, project.sequences],
  );
  const assets = useMemo(
    () => project.assets.filter((asset) => asset.name.toLowerCase().includes(normalizedQuery)),
    [normalizedQuery, project.assets],
  );
  const availableAssetIds = useMemo(
    () => project.assets.map((asset) => asset.id),
    [project.assets],
  );
  const visibleAssetIds = useMemo(() => assets.map((asset) => asset.id), [assets]);
  const selection = useMediaBinSelection({ availableAssetIds, visibleAssetIds });
  const selectedAssets = project.assets.filter((asset) => selection.selectedIds.has(asset.id));
  const selectedCount = selectedAssets.length;
  const usage = useMemo(
    () => summarizeAssetUsage(project, selection.selectedIds),
    [project, selection.selectedIds],
  );
  const pendingSequence =
    dialog?.kind === "remove-sequence"
      ? (project.sequences.find((sequence) => sequence.id === dialog.sequenceId) ?? null)
      : null;

  const importProjectMedia = useRendererStore((state) => state.importMedia);
  const appendAsset = useRendererStore((state) => state.appendAsset);
  const execute = useRendererStore((state) => state.execute);
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const setSelectedAssetIds = useRendererStore((state) => state.setSelectedAssetIds);
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
  const selectedAsset = selectedAssets.length === 1 ? selectedAssets[0] : undefined;
  const selectedTransfer = selectedAsset
    ? cloudTransfers.find((transfer) => transfer.assetId === selectedAsset.id)
    : undefined;
  const retryAssetId = retryableAssetId(selectedAsset, selectedTransfer);
  const selectedCloudAsset = selectedAsset?.source.kind === "cloud" ? selectedAsset : null;
  const selectedProxyAssets = selectedAssets.filter((asset) =>
    assetNeedsEditProxy(asset, derivedMedia?.assets[asset.id]),
  );
  const selectedTranscriptAssets = selectedAssets.filter(
    (asset) => asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio === true),
  );
  const transcriptAction = transcriptActionFor(selectedTranscriptAssets, transcripts);
  const importMedia = useCallback(async () => importProjectMedia(), [importProjectMedia]);

  useEffect(() => {
    setSelectedAssetIds([...selection.selectedIds]);
  }, [selection.selectedIds, setSelectedAssetIds]);

  useEffect(() => () => setSelectedAssetIds([]), [setSelectedAssetIds]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        void importMedia();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [importMedia]);

  async function addToTimeline(asset: Asset) {
    await appendAsset(asset.id, activeSequenceId ?? project.activeSequenceId);
  }

  function requestTimelineCreation() {
    setTimelineName(nextTimelineName(project));
    setDialog({ kind: "create-timeline" });
  }

  async function createTimeline() {
    if (!timelineName.trim() || selectedAssets.length === 0) return;
    const formatSource =
      project.sequences.find((sequence) => sequence.id === activeSequenceId) ??
      project.sequences.find((sequence) => sequence.id === project.activeSequenceId);
    const result = await execute({
      type: "sequence.createFromAssets",
      assetIds: selectedAssets.map((asset) => asset.id),
      name: timelineName.trim(),
      ...(formatSource
        ? {
            width: formatSource.width,
            height: formatSource.height,
            frameRate: formatSource.frameRate,
          }
        : {}),
    });
    if (!result.ok) return;
    setDialog(null);
    selection.clear();
    onOpenTimeline(result.value.project.activeSequenceId);
  }

  async function removeAssets() {
    if (selectedAssets.length === 0 || usage.lockedTrackName) return;
    const cloudAssetIds = selectedAssets.flatMap((asset) =>
      asset.source.kind === "cloud" ? [asset.source.cloudAssetId] : [],
    );
    const result = await execute({
      type: "asset.remove",
      assetIds: selectedAssets.map((asset) => asset.id),
    });
    if (!result.ok) return;
    if (cloudAssetIds.length > 0)
      await window.cinesim.cloud.trashAssets(cloudAssetIds).catch(() => undefined);
    setDialog(null);
    selection.clear();
  }

  async function removeSequence(sequence: Sequence) {
    const result = await execute({ type: "sequence.remove", sequenceId: sequence.id });
    if (result.ok) setDialog(null);
  }

  async function generateSelectedProxies() {
    const mediaIds = selectedProxyAssets.map((asset) => asset.id);
    if (mediaIds.length > 0 && derivedScope)
      await window.cinesim.derived.requestProxies(derivedScope, mediaIds);
  }

  function toggleCloudOriginal(assetId: AssetId) {
    if (downloadedCloudOriginals.includes(assetId)) void removeCloudOriginalDownload(assetId);
    else void keepCloudOriginalDownloaded(assetId);
  }

  function runTranscriptAction() {
    const assetIds = selectedTranscriptAssets.map((asset) => asset.id);
    if (transcriptAction === "cancel") void cancelTranscripts(assetIds);
    else if (transcriptAction === "regenerate") void regenerateTranscripts(assetIds);
    else if (transcriptAction === "generate") void requestTranscripts(assetIds);
  }

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-canvas">
      <LibraryToolbar
        title="Media"
        count={project.sequences.length + project.assets.length}
        search={
          <SearchField
            className="w-96 min-w-52 max-w-[32vw]"
            placeholder="Search media and timelines"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        }
      >
        <div className="flex w-28 shrink-0 justify-end">
          {selectedCount > 0 && (
            <div className="flex h-8 items-center gap-2 rounded-md border border-accent/60 bg-accent/10 px-2 text-ui-xs font-medium text-primary">
              <span>{selectedCount} selected</span>
              <button
                type="button"
                className="grid size-5 place-items-center rounded hover:bg-surface"
                aria-label="Clear asset selection"
                onClick={selection.clear}
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>
        <LibraryViewToggle label="Media view" view={view} onViewChange={setView} />
        <Button onClick={() => void importMedia()}>
          Import media
          <Kbd className="ml-1">{modifier}I</Kbd>
        </Button>
      </LibraryToolbar>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <MediaBinContextMenu
          canRevealAsset={selectedAsset?.source.kind === "local"}
          cloudAssetId={selectedCloudAsset?.id ?? null}
          cloudOriginalDownloaded={
            selectedCloudAsset ? downloadedCloudOriginals.includes(selectedCloudAsset.id) : false
          }
          hasProxyAssets={selectedProxyAssets.length > 0}
          retryAssetId={retryAssetId}
          selectedAssetIds={selection.selectedIds}
          selectedCount={selectedCount}
          transcriptAction={transcriptAction}
          transcriptionAvailable={account.status === "signed-in" && account.transcription}
          onClearSelection={selection.clear}
          onCreateTimeline={requestTimelineCreation}
          onGenerateProxies={() => void generateSelectedProxies()}
          onOpenTimeline={onOpenTimeline}
          onRemoveAssets={() => setDialog({ kind: "remove-assets" })}
          onRemoveSequence={(sequenceId) => setDialog({ kind: "remove-sequence", sequenceId })}
          onRevealAsset={() => {
            if (selectedAsset)
              void window.cinesim.project.revealAsset(selectedAsset.id).catch(() => undefined);
          }}
          onRetryCloudTransfer={(assetId) => void retryCloudTransfer(assetId)}
          onSelectOnly={selection.selectOnly}
          onToggleCloudOriginal={toggleCloudOriginal}
          onTranscriptAction={runTranscriptAction}
        >
          {view === "grid" ? (
            <MediaBinGrid
              assets={assets}
              cloudTransfers={cloudTransfers}
              downloadedCloudOriginals={downloadedCloudOriginals}
              gridRef={selection.gridRef}
              hasQuery={Boolean(normalizedQuery)}
              query={query}
              selectedAssetIds={selection.selectedIds}
              sequences={sequences}
              onAddAsset={(asset) => void addToTimeline(asset)}
              onOpenTimeline={onOpenTimeline}
              onPointerCancel={selection.finishMarquee}
              onPointerDown={selection.beginMarquee}
              onPointerMove={selection.moveMarquee}
              onPointerUp={selection.finishMarquee}
              onSelectAsset={(assetId, event) => selection.select(assetId, event)}
            />
          ) : (
            <MediaBinList
              assets={assets}
              cloudTransfers={cloudTransfers}
              downloadedCloudOriginals={downloadedCloudOriginals}
              hasQuery={Boolean(normalizedQuery)}
              query={query}
              selectedAssetIds={selection.selectedIds}
              sequences={sequences}
              onAddAsset={(asset) => void addToTimeline(asset)}
              onOpenTimeline={onOpenTimeline}
              onSelectAsset={(assetId, event) => selection.select(assetId, event)}
            />
          )}
        </MediaBinContextMenu>
      </div>

      {selection.marquee && selection.marquee.width + selection.marquee.height > 4 && (
        <div
          className="pointer-events-none fixed z-50 border border-accent bg-accent/15"
          style={{
            left: selection.marquee.x,
            top: selection.marquee.y,
            width: selection.marquee.width,
            height: selection.marquee.height,
          }}
        />
      )}

      <MediaBinDialogs
        dialog={dialog}
        pendingSequence={pendingSequence}
        selectedCount={selectedCount}
        sequenceCount={project.sequences.length}
        timelineName={timelineName}
        usage={usage}
        onClose={() => setDialog(null)}
        onCreateTimeline={() => void createTimeline()}
        onRemoveAssets={() => void removeAssets()}
        onRemoveSequence={(sequence) => void removeSequence(sequence)}
        onTimelineNameChange={setTimelineName}
      />
    </section>
  );
}

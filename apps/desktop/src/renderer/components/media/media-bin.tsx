import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  Clock3,
  Cloud,
  Film,
  HardDriveDownload,
  ListPlus,
  LoaderCircle,
  Pause,
  RotateCcw,
  Trash2,
  X,
} from "@cinesim/ui";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Kbd,
  PaneHeader,
  PreviewCard,
  SearchField,
} from "@cinesim/ui";
import { sequenceDurationUs } from "@cinesim/core";
import type { Asset, AssetId, Project, Sequence } from "@cinesim/core";
import { formatDuration } from "../../lib/format";
import { useRendererStore } from "../../store/renderer-store-context";
import { LibraryGrid } from "../shared/library-card";
import { AssetSourceMetadata } from "./asset-source-metadata";
import { assetNeedsEditProxy } from "./media-actions";
import { MediaSkimSurface } from "./media-skim-surface";

interface MediaBinProps {
  project: Project;
  onOpenTimeline: (sequenceId: string) => void;
}

interface Point {
  x: number;
  y: number;
}

interface SelectionRect extends Point {
  width: number;
  height: number;
}

type PendingDialog =
  | { kind: "create-timeline" }
  | { kind: "remove-assets" }
  | { kind: "remove-sequence"; sequenceId: string };

type ContextMenuTarget = { kind: "assets" } | { kind: "sequence"; sequenceId: string };

function nextTimelineName(project: Project): string {
  const ordinals = project.sequences
    .map((sequence) => /^Timeline (\d+)$/.exec(sequence.name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  return `Timeline ${Math.max(1, ...ordinals) + 1}`;
}

function intersects(selection: SelectionRect, target: DOMRect): boolean {
  return (
    selection.x < target.right &&
    selection.x + selection.width > target.left &&
    selection.y < target.bottom &&
    selection.y + selection.height > target.top
  );
}

export function MediaBin({ project, onOpenTimeline }: MediaBinProps) {
  const [query, setQuery] = useState("");
  const [selection, setSelectedAssetIds] = useState<Set<AssetId>>(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<AssetId | null>(null);
  const [marquee, setMarquee] = useState<SelectionRect | null>(null);
  const [contextMenuTarget, setContextMenuTarget] = useState<ContextMenuTarget | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  const [timelineName, setTimelineName] = useState("");
  const marqueeOrigin = useRef<Point | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
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
  const selectedAssetIds = useMemo(() => {
    const available = new Set(project.assets.map((asset) => asset.id));
    return new Set([...selection].filter((assetId) => available.has(assetId)));
  }, [project.assets, selection]);
  const selectedAssets = project.assets.filter((asset) => selectedAssetIds.has(asset.id));
  const selectedCount = selectedAssets.length;
  const clipUsages = project.sequences.flatMap((sequence) =>
    sequence.tracks.flatMap((track) =>
      track.clips
        .filter((clip) => selectedAssetIds.has(clip.assetId))
        .map((clip) => ({ sequence, track, clip })),
    ),
  );
  const affectedTimelineCount = new Set(clipUsages.map(({ sequence }) => sequence.id)).size;
  const lockedUsage = clipUsages.find(({ track }) => track.locked);
  const pendingSequence =
    pendingDialog?.kind === "remove-sequence"
      ? (project.sequences.find((sequence) => sequence.id === pendingDialog.sequenceId) ?? null)
      : null;

  const importProjectMedia = useRendererStore((state) => state.importMedia);
  const appendAsset = useRendererStore((state) => state.appendAsset);
  const execute = useRendererStore((state) => state.execute);
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const cloudTransfers = useRendererStore((state) => state.cloudTransfers);
  const derivedMedia = useRendererStore((state) => state.derivedMedia);
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
  const selectedTransfer =
    selectedAssets.length === 1
      ? cloudTransfers.find((transfer) => transfer.assetId === selectedAssets[0]?.id)
      : undefined;
  const selectedCloudAsset =
    selectedAssets.length === 1 && selectedAssets[0]?.source.kind === "cloud"
      ? selectedAssets[0]
      : null;
  const selectedProxyAssets = selectedAssets.filter((asset) =>
    assetNeedsEditProxy(asset, derivedMedia?.assets[asset.id]),
  );
  const importMedia = useCallback(async () => importProjectMedia(), [importProjectMedia]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedAssetIds(new Set());
        setSelectionAnchor(null);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

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

  function selectAsset(assetId: AssetId, event: React.MouseEvent<HTMLButtonElement>) {
    const visibleIds = assets.map((asset) => asset.id);
    if (event.shiftKey && selectionAnchor) {
      const anchorIndex = visibleIds.indexOf(selectionAnchor);
      const targetIndex = visibleIds.indexOf(assetId);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        setSelectedAssetIds(new Set(visibleIds.slice(start, end + 1)));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setSelectedAssetIds((current) => {
        const next = new Set(current);
        if (next.has(assetId)) next.delete(assetId);
        else next.add(assetId);
        return next;
      });
    } else setSelectedAssetIds(new Set([assetId]));
    setSelectionAnchor(assetId);
  }

  function beginMarquee(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    marqueeOrigin.current = { x: event.clientX, y: event.clientY };
    setSelectedAssetIds(new Set());
    setSelectionAnchor(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveMarquee(event: React.PointerEvent<HTMLDivElement>) {
    const origin = marqueeOrigin.current;
    if (!origin) return;
    const rectangle = {
      x: Math.min(origin.x, event.clientX),
      y: Math.min(origin.y, event.clientY),
      width: Math.abs(event.clientX - origin.x),
      height: Math.abs(event.clientY - origin.y),
    };
    setMarquee(rectangle);
    const selected = new Set<AssetId>();
    for (const element of gridRef.current?.querySelectorAll<HTMLElement>("[data-asset-id]") ?? []) {
      if (intersects(rectangle, element.getBoundingClientRect()))
        selected.add(element.dataset.assetId as AssetId);
    }
    setSelectedAssetIds(selected);
  }

  function finishMarquee(event: React.PointerEvent<HTMLDivElement>) {
    if (!marqueeOrigin.current) return;
    marqueeOrigin.current = null;
    setMarquee(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function requestTimelineCreation() {
    setTimelineName(nextTimelineName(project));
    setPendingDialog({ kind: "create-timeline" });
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
    setPendingDialog(null);
    setSelectedAssetIds(new Set());
    setSelectionAnchor(null);
    onOpenTimeline(result.value.project.activeSequenceId);
  }

  async function removeAssets() {
    if (selectedAssets.length === 0 || lockedUsage) return;
    const cloudAssetIds = selectedAssets.flatMap((asset) =>
      asset.source.kind === "cloud" ? [asset.source.cloudAssetId] : [],
    );
    const result = await execute({
      type: "asset.remove",
      assetIds: selectedAssets.map((asset) => asset.id),
    });
    if (!result.ok) return;
    if (cloudAssetIds.length > 0)
      await window.cinesim.trashCloudAssets(cloudAssetIds).catch(() => undefined);
    setPendingDialog(null);
    setSelectedAssetIds(new Set());
    setSelectionAnchor(null);
  }

  async function removeSequence(sequence: Sequence) {
    const result = await execute({ type: "sequence.remove", sequenceId: sequence.id });
    if (result.ok) setPendingDialog(null);
  }

  async function generateSelectedProxies(): Promise<void> {
    const mediaIds = selectedProxyAssets.map((asset) => asset.id);
    if (mediaIds.length > 0 && derivedScope)
      await window.cinesim.requestProxyJobs(derivedScope, mediaIds);
  }

  function assetContextMenu() {
    return (
      <>
        <ContextMenuItem onClick={requestTimelineCreation}>
          <ListPlus size={14} /> Create Timeline from {selectedCount}{" "}
          {selectedCount === 1 ? "Asset" : "Assets"}
        </ContextMenuItem>
        {selectedProxyAssets.length > 0 && (
          <ContextMenuItem onClick={() => void generateSelectedProxies()}>
            <Film size={14} /> Generate edit {selectedCount === 1 ? "proxy" : "proxies"}
          </ContextMenuItem>
        )}
        {selectedTransfer &&
          ["waiting-for-cloud", "paused", "failed"].includes(selectedTransfer.state) && (
            <ContextMenuItem onClick={() => void retryCloudTransfer(selectedAssets[0]!.id)}>
              <RotateCcw size={14} /> Retry cloud upload
            </ContextMenuItem>
          )}
        {selectedCloudAsset && (
          <ContextMenuItem
            onClick={() => {
              const downloaded = downloadedCloudOriginals.includes(selectedCloudAsset.id);
              if (downloaded) void removeCloudOriginalDownload(selectedCloudAsset.id);
              else void keepCloudOriginalDownloaded(selectedCloudAsset.id);
            }}
          >
            {downloadedCloudOriginals.includes(selectedCloudAsset.id) ? (
              <>
                <X size={14} /> Remove download
              </>
            ) : (
              <>
                <HardDriveDownload size={14} /> Keep downloaded
              </>
            )}
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => setPendingDialog({ kind: "remove-assets" })}>
          <Trash2 size={14} /> Remove {selectedCount} {selectedCount === 1 ? "Asset" : "Assets"}{" "}
          from Project
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            setSelectedAssetIds(new Set());
            setSelectionAnchor(null);
          }}
        >
          <X size={14} /> Clear Selection
        </ContextMenuItem>
      </>
    );
  }

  function sequenceContextMenu(sequenceId: string) {
    return (
      <>
        <ContextMenuItem onClick={() => onOpenTimeline(sequenceId)}>
          <Film size={14} /> Open Timeline
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setPendingDialog({ kind: "remove-sequence", sequenceId })}>
          <Trash2 size={14} /> Delete Timeline
        </ContextMenuItem>
      </>
    );
  }

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-canvas">
      <PaneHeader size="lg" className="gap-3">
        <SearchField
          className="min-w-52 max-w-sm flex-1"
          placeholder="Search media and timelines"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {selectedCount > 0 ? (
          <div className="ml-auto flex h-8 items-center gap-2 rounded-md border border-accent/60 bg-accent/10 px-2 text-ui-xs font-medium text-primary">
            <span>{selectedCount} selected</span>
            <button
              type="button"
              className="grid size-5 place-items-center rounded hover:bg-surface"
              aria-label="Clear asset selection"
              onClick={() => {
                setSelectedAssetIds(new Set());
                setSelectionAnchor(null);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <span className="ml-auto text-ui-xs text-muted">
            {project.sequences.length + project.assets.length} items
          </span>
        )}
        <Button onClick={() => void importMedia()}>
          Import media
          <Kbd className="ml-1">{modifier}I</Kbd>
        </Button>
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <ContextMenu>
          <ContextMenuTrigger
            className="contents"
            onContextMenu={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              const assetId = target?.closest<HTMLElement>("[data-asset-id]")?.dataset.assetId as
                | AssetId
                | undefined;
              if (assetId) {
                if (!selectedAssetIds.has(assetId)) {
                  setSelectedAssetIds(new Set([assetId]));
                  setSelectionAnchor(assetId);
                }
                setContextMenuTarget({ kind: "assets" });
                return;
              }
              const sequenceId =
                target?.closest<HTMLElement>("[data-sequence-id]")?.dataset.sequenceId;
              if (sequenceId) {
                setContextMenuTarget({ kind: "sequence", sequenceId });
                return;
              }
              event.preventBaseUIHandler();
            }}
          >
            <LibraryGrid
              ref={gridRef}
              className="min-h-full content-start select-none"
              onPointerDown={beginMarquee}
              onPointerMove={moveMarquee}
              onPointerUp={finishMarquee}
              onPointerCancel={finishMarquee}
            >
              {sequences.map((sequence) => (
                <div key={sequence.id} data-sequence-id={sequence.id}>
                  <PreviewCard
                    ariaLabel={`Open ${sequence.name}`}
                    title="Double-click to open timeline"
                    previewClassName="timeline-thumbnail"
                    preview={null}
                    bottomCorner={
                      <span className="rounded bg-panel/90 px-1.5 py-0.5 text-ui-xs tabular-nums text-secondary">
                        {formatDuration(sequenceDurationUs(sequence))}
                      </span>
                    }
                    onDoubleClick={() => onOpenTimeline(sequence.id)}
                  >
                    <p className="truncate text-ui font-medium text-primary">{sequence.name}</p>
                    <p className="mt-1 flex items-center gap-1 text-ui-xs text-muted">
                      <Clock3 size={11} /> {sequence.frameRate} fps · {sequence.width} ×{" "}
                      {sequence.height}
                    </p>
                  </PreviewCard>
                </div>
              ))}

              {assets.map((asset) => {
                const selected = selectedAssetIds.has(asset.id);
                const transfer = cloudTransfers.find((candidate) => candidate.assetId === asset.id);
                const originalDownloaded = downloadedCloudOriginals.includes(asset.id);
                const storageState =
                  asset.source.kind === "cloud"
                    ? originalDownloaded
                      ? {
                          label: "Cloud original · downloaded",
                          icon: <HardDriveDownload size={10} />,
                        }
                      : { label: "Cloud original", icon: <Cloud size={10} /> }
                    : transfer?.state === "waiting-for-cloud"
                      ? { label: "Waiting for cloud", icon: <Pause size={10} /> }
                      : transfer?.state === "failed"
                        ? {
                            label: "Cloud upload failed",
                            icon: <CircleAlert size={10} className="text-red-400" />,
                          }
                        : transfer?.state === "paused"
                          ? { label: "Cloud upload paused", icon: <Pause size={10} /> }
                          : transfer?.state === "waiting-for-proxy"
                            ? {
                                label: "Cloud ready · finishing proxy",
                                icon: <LoaderCircle size={10} className="animate-spin" />,
                              }
                            : transfer?.state === "preparing"
                              ? {
                                  label: "Preparing cloud upload",
                                  icon: <LoaderCircle size={10} className="animate-spin" />,
                                }
                              : transfer?.state === "uploading"
                                ? {
                                    label: `${Math.round((transfer.uploadedBytes / Math.max(1, transfer.bytes)) * 100)}% uploaded`,
                                    icon: <LoaderCircle size={10} className="animate-spin" />,
                                  }
                                : { label: "Local original", icon: <Film size={10} /> };
                return (
                  <div key={asset.id} data-asset-id={asset.id}>
                    <PreviewCard
                      ariaLabel={`Select ${asset.name}`}
                      title="Select, double-click to add, or right-click for actions"
                      selected={selected}
                      previewClassName="media-thumbnail"
                      preview={<MediaSkimSurface asset={asset} />}
                      corner={
                        selected ? (
                          <span className="grid size-6 place-items-center rounded-full bg-accent text-on-accent shadow-md">
                            <Check size={14} strokeWidth={3} />
                          </span>
                        ) : undefined
                      }
                      bottomCorner={
                        <div className="flex items-center gap-1.5">
                          <span
                            className="flex items-center gap-1 rounded bg-panel/90 px-1.5 py-0.5 text-ui-xs text-secondary"
                            title={transfer?.error ?? storageState.label}
                          >
                            {storageState.icon}
                            {storageState.label}
                          </span>
                          <span className="rounded bg-panel/90 px-1.5 py-0.5 text-ui-xs tabular-nums text-secondary">
                            {formatDuration(asset.durationUs)}
                          </span>
                        </div>
                      }
                      onClick={(event) => selectAsset(asset.id, event)}
                      onDoubleClick={() => void addToTimeline(asset)}
                    >
                      <p className="truncate text-ui font-medium text-primary" title={asset.name}>
                        {asset.name}
                      </p>
                      <p className="mt-1 truncate text-ui-xs text-muted tabular-nums">{asset.id}</p>
                      <AssetSourceMetadata
                        asset={asset}
                        className="mt-0.5 truncate text-ui-xs text-muted tabular-nums"
                      />
                    </PreviewCard>
                  </div>
                );
              })}

              {normalizedQuery && sequences.length === 0 && assets.length === 0 && (
                <div className="col-span-full rounded-xl border border-dashed border-border-strong px-5 py-10 text-center text-ui text-muted">
                  Nothing matches “{query}”.
                </div>
              )}
            </LibraryGrid>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-64" positionerClassName="z-[90]">
            {contextMenuTarget?.kind === "assets"
              ? assetContextMenu()
              : contextMenuTarget?.kind === "sequence"
                ? sequenceContextMenu(contextMenuTarget.sequenceId)
                : null}
          </ContextMenuContent>
        </ContextMenu>
      </div>

      {marquee && marquee.width + marquee.height > 4 && (
        <div
          className="pointer-events-none fixed z-50 border border-accent bg-accent/15"
          style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
        />
      )}

      <Dialog
        open={pendingDialog !== null}
        onOpenChange={(open) => !open && setPendingDialog(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingDialog?.kind === "create-timeline"
                ? "Create timeline"
                : pendingDialog?.kind === "remove-sequence"
                  ? "Delete timeline"
                  : "Remove assets"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 p-4">
            {pendingDialog?.kind === "create-timeline" ? (
              <>
                <DialogDescription>
                  Place {selectedCount} selected {selectedCount === 1 ? "asset" : "assets"}{" "}
                  sequentially in a new timeline.
                </DialogDescription>
                <label
                  className="block text-ui-xs font-medium text-secondary"
                  htmlFor="new-timeline-name"
                >
                  Timeline name
                  <Input
                    id="new-timeline-name"
                    className="mt-1 w-full"
                    maxLength={120}
                    value={timelineName}
                    onChange={(event) => setTimelineName(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void createTimeline()}
                  />
                </label>
              </>
            ) : pendingDialog?.kind === "remove-assets" ? (
              <DialogDescription>
                {lockedUsage
                  ? `Unlock “${lockedUsage.track.name}” before removing these assets.`
                  : `Remove ${selectedCount} ${selectedCount === 1 ? "asset" : "assets"} and ${clipUsages.length} ${clipUsages.length === 1 ? "clip" : "clips"} across ${affectedTimelineCount} ${affectedTimelineCount === 1 ? "timeline" : "timelines"}? Original source files will not be deleted.`}
              </DialogDescription>
            ) : pendingSequence ? (
              <DialogDescription>
                {project.sequences.length === 1
                  ? "A project must keep at least one timeline."
                  : pendingSequence.tracks.some((track) => track.locked)
                    ? "Unlock every track before deleting this timeline."
                    : `Delete “${pendingSequence.name}” and its ${pendingSequence.tracks.reduce((count, track) => count + track.clips.length, 0)} clips? Assets remain in the Media tab.`}
              </DialogDescription>
            ) : null}
          </div>
          <DialogFooter className="border-t border-border p-4">
            <Button variant="ghost" onClick={() => setPendingDialog(null)}>
              Cancel
            </Button>
            {pendingDialog?.kind === "create-timeline" ? (
              <Button
                variant="primary"
                disabled={!timelineName.trim()}
                onClick={() => void createTimeline()}
              >
                Create Timeline
              </Button>
            ) : pendingDialog?.kind === "remove-assets" ? (
              <Button
                variant="danger"
                disabled={Boolean(lockedUsage)}
                onClick={() => void removeAssets()}
              >
                Remove Assets
              </Button>
            ) : pendingSequence ? (
              <Button
                variant="danger"
                disabled={
                  project.sequences.length === 1 ||
                  pendingSequence.tracks.some((track) => track.locked)
                }
                onClick={() => void removeSequence(pendingSequence)}
              >
                Delete Timeline
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

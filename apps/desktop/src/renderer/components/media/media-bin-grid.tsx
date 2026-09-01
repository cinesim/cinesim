import type { MouseEvent, PointerEventHandler, RefObject } from "react";
import {
  Check,
  CircleAlert,
  Cloud,
  Film,
  HardDriveDownload,
  LoaderCircle,
  Pause,
  PreviewCard,
} from "@cinesim/ui";
import { sequenceDurationUs } from "@cinesim/core";
import type { Asset, AssetId, Sequence } from "@cinesim/core";
import type { CloudTransferSnapshot } from "../../../shared/contracts";
import { formatDuration } from "../../lib/format";
import { LibraryGrid } from "../shared/library-card";
import { assetCompatibilityLabel, AssetSourceMetadata } from "./asset-source-metadata";
import { assetStoragePresentation } from "./media-bin-model";
import type { AssetStorageStatus } from "./media-bin-model";
import { MediaSkimSurface } from "./media-skim-surface";
import { MediaTranscriptBadge } from "./media-transcript-badge";

interface MediaBinGridProps {
  assets: readonly Asset[];
  cloudTransfers: readonly CloudTransferSnapshot[];
  downloadedCloudOriginals: readonly string[];
  gridRef: RefObject<HTMLDivElement | null>;
  hasQuery: boolean;
  onAddAsset: (asset: Asset) => void;
  onOpenTimeline: (sequenceId: string) => void;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onSelectAsset: (assetId: AssetId, event: MouseEvent<HTMLButtonElement>) => void;
  query: string;
  selectedAssetIds: ReadonlySet<AssetId>;
  sequences: readonly Sequence[];
}

function StorageIcon({ status }: { status: AssetStorageStatus }) {
  switch (status) {
    case "cloud-downloaded":
      return <HardDriveDownload size={10} />;
    case "cloud-original":
      return <Cloud size={10} />;
    case "upload-failed":
      return <CircleAlert size={10} className="text-red-400" />;
    case "waiting-for-cloud":
    case "paused":
      return <Pause size={10} />;
    case "preparing":
    case "uploading":
    case "waiting-for-proxy":
      return <LoaderCircle size={10} className="animate-spin" />;
    case "local":
      return <Film size={10} />;
  }
}

export function MediaBinGrid({
  assets,
  cloudTransfers,
  downloadedCloudOriginals,
  gridRef,
  hasQuery,
  onAddAsset,
  onOpenTimeline,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onSelectAsset,
  query,
  selectedAssetIds,
  sequences,
}: MediaBinGridProps) {
  return (
    <LibraryGrid
      ref={gridRef}
      className="min-h-full content-start select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {sequences.map((sequence) => (
        <div key={sequence.id} data-sequence-id={sequence.id}>
          <PreviewCard
            ariaLabel={`Open ${sequence.name}`}
            title="Double-click to open timeline"
            variant="frameless"
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
            <p className="mt-0.5 text-ui-xs text-muted tabular-nums">
              {sequence.width} × {sequence.height} · {sequence.frameRate} fps
            </p>
          </PreviewCard>
        </div>
      ))}

      {assets.map((asset) => {
        const selected = selectedAssetIds.has(asset.id);
        const transfer = cloudTransfers.find((candidate) => candidate.assetId === asset.id);
        const storage = assetStoragePresentation(
          asset,
          transfer,
          downloadedCloudOriginals.includes(asset.id),
        );
        const compatibility = assetCompatibilityLabel(asset);
        return (
          <div key={asset.id} data-asset-id={asset.id}>
            <PreviewCard
              ariaLabel={`Select ${asset.name}`}
              title="Select, double-click to add, or right-click for actions"
              selected={selected}
              variant="frameless"
              previewClassName="media-thumbnail"
              preview={<MediaSkimSurface asset={asset} />}
              corner={
                selected ? (
                  <span className="grid size-6 place-items-center rounded-full bg-accent text-on-accent shadow-md">
                    <Check size={14} strokeWidth={3} />
                  </span>
                ) : compatibility ? (
                  <span
                    className="grid size-6 place-items-center rounded-full bg-panel/90 text-amber-400 shadow-md"
                    title={compatibility}
                  >
                    <CircleAlert size={14} />
                  </span>
                ) : undefined
              }
              bottomCorner={
                <div className="flex items-center gap-1.5">
                  <MediaTranscriptBadge asset={asset} />
                  <span
                    className="flex items-center gap-1 rounded bg-panel/90 px-1.5 py-0.5 text-ui-xs text-secondary"
                    title={transfer?.error ?? storage.label}
                  >
                    <StorageIcon status={storage.kind} />
                    {storage.label}
                  </span>
                  <span className="rounded bg-panel/90 px-1.5 py-0.5 text-ui-xs tabular-nums text-secondary">
                    {formatDuration(asset.durationUs)}
                  </span>
                </div>
              }
              onClick={(event) => onSelectAsset(asset.id, event)}
              onDoubleClick={() => onAddAsset(asset)}
            >
              <p className="truncate text-ui font-medium text-primary" title={asset.name}>
                {asset.name}
              </p>
              <AssetSourceMetadata
                asset={asset}
                className="mt-0.5 truncate text-ui-xs text-muted tabular-nums"
              />
            </PreviewCard>
          </div>
        );
      })}

      {hasQuery && sequences.length === 0 && assets.length === 0 && (
        <div className="col-span-full rounded-xl border border-dashed border-border-strong px-5 py-10 text-center text-ui text-muted">
          Nothing matches “{query}”.
        </div>
      )}
    </LibraryGrid>
  );
}

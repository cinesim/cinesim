import type { MouseEvent, PointerEventHandler, RefObject } from "react";
import { PreviewCard } from "@cinesim/ui";
import { sequenceDurationUs } from "@cinesim/core";
import type { Asset, AssetId, Sequence } from "@cinesim/core";
import type { CloudTransferSnapshot } from "../../../shared/contracts";
import { formatDuration } from "../../lib/format";
import { LibraryGrid } from "../shared/library-card";
import { assetStoragePresentation } from "./media-bin-model";
import { MediaAssetCard } from "./media-asset-presentation";

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
        return (
          <div key={asset.id} data-asset-id={asset.id}>
            <MediaAssetCard
              asset={asset}
              storage={storage}
              {...(transfer?.error ? { storageDetail: transfer.error } : {})}
              selected={selected}
              onClick={(event) => onSelectAsset(asset.id, event)}
              onDoubleClick={() => onAddAsset(asset)}
            />
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

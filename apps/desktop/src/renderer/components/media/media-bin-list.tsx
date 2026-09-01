import type { MouseEvent } from "react";
import { cn } from "@cinesim/ui";
import { sequenceDurationUs } from "@cinesim/core";
import type { Asset, AssetId, Sequence } from "@cinesim/core";
import type { CloudTransferSnapshot } from "../../../shared/contracts";
import { formatDuration } from "../../lib/format";
import { LibraryList, LibraryListRow } from "../shared/library-card";
import { assetCompatibilityLabel, assetSourceMetadataLabel } from "./asset-source-metadata";
import { assetStoragePresentation } from "./media-bin-model";
import { MediaSkimSurface } from "./media-skim-surface";

const MEDIA_LIST_COLUMNS =
  "grid-cols-[minmax(280px,1.5fr)_110px_120px_minmax(190px,0.8fr)_minmax(220px,1fr)]";

interface MediaBinListProps {
  assets: readonly Asset[];
  cloudTransfers: readonly CloudTransferSnapshot[];
  downloadedCloudOriginals: readonly string[];
  hasQuery: boolean;
  onAddAsset: (asset: Asset) => void;
  onOpenTimeline: (sequenceId: string) => void;
  onSelectAsset: (assetId: AssetId, event: MouseEvent<HTMLButtonElement>) => void;
  query: string;
  selectedAssetIds: ReadonlySet<AssetId>;
  sequences: readonly Sequence[];
}

const CELL_CLASS_NAME = "px-3 py-2.5";

function kindLabel(kind: Asset["kind"]): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function sequenceFormat(sequence: Sequence): string {
  return `${sequence.width} × ${sequence.height} · ${Number(sequence.frameRate.toFixed(2))} fps`;
}

export function MediaBinList({
  assets,
  cloudTransfers,
  downloadedCloudOriginals,
  hasQuery,
  onAddAsset,
  onOpenTimeline,
  onSelectAsset,
  query,
  selectedAssetIds,
  sequences,
}: MediaBinListProps) {
  return (
    <LibraryList
      columnsClassName={MEDIA_LIST_COLUMNS}
      minWidthClassName="min-w-[980px]"
      headers={["Name", "Type", "Duration", "Format", "Storage"]}
    >
      {sequences.map((sequence) => (
        <LibraryListRow
          key={sequence.id}
          data-sequence-id={sequence.id}
          columnsClassName={MEDIA_LIST_COLUMNS}
          aria-label={`Open ${sequence.name}`}
          onDoubleClick={() => onOpenTimeline(sequence.id)}
        >
          <span className="flex min-w-0 items-center gap-3 px-3 py-2.5">
            <span className="timeline-thumbnail block aspect-video w-14 shrink-0 overflow-hidden rounded" />
            <span className="truncate font-medium text-primary">{sequence.name}</span>
          </span>
          <span className={CELL_CLASS_NAME}>Timeline</span>
          <span className={cn(CELL_CLASS_NAME, "tabular-nums")}>
            {formatDuration(sequenceDurationUs(sequence))}
          </span>
          <span className={cn(CELL_CLASS_NAME, "tabular-nums")}>{sequenceFormat(sequence)}</span>
          <span className={cn(CELL_CLASS_NAME, "text-muted")}>—</span>
        </LibraryListRow>
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
          <LibraryListRow
            key={asset.id}
            data-asset-id={asset.id}
            columnsClassName={MEDIA_LIST_COLUMNS}
            selected={selected}
            aria-label={`Select ${asset.name}`}
            onClick={(event) => onSelectAsset(asset.id, event)}
            onDoubleClick={() => onAddAsset(asset)}
          >
            <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <div
                className={cn(
                  "media-thumbnail block aspect-video w-14 shrink-0 overflow-hidden rounded",
                  selected && "ring-2 ring-accent/70",
                )}
              >
                <MediaSkimSurface asset={asset} />
              </div>
              <span className="truncate font-medium text-primary">{asset.name}</span>
            </div>
            <span className={CELL_CLASS_NAME}>{kindLabel(asset.kind)}</span>
            <span className={cn(CELL_CLASS_NAME, "tabular-nums")}>
              {formatDuration(asset.durationUs)}
            </span>
            <span className={cn(CELL_CLASS_NAME, "tabular-nums")}>
              <span title={assetCompatibilityLabel(asset) ?? undefined}>
                {assetSourceMetadataLabel(asset) ?? "—"}
                {assetCompatibilityLabel(asset) ? " · ⚠" : ""}
              </span>
            </span>
            <span className={cn(CELL_CLASS_NAME, "truncate text-muted")}>{storage.label}</span>
          </LibraryListRow>
        );
      })}

      {hasQuery && sequences.length === 0 && assets.length === 0 && (
        <div className="px-5 py-10 text-center text-ui text-muted">Nothing matches “{query}”.</div>
      )}
    </LibraryList>
  );
}

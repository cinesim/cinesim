import type { MouseEventHandler, ReactNode } from "react";
import {
  Check,
  CircleAlert,
  Cloud,
  cn,
  Film,
  HardDriveDownload,
  LoaderCircle,
  Pause,
  PreviewCard,
} from "@cinesim/ui";
import type { Asset, TimeUs } from "@cinesim/core";
import { formatDuration } from "../../lib/format";
import { LibraryListRow } from "../shared/library-card";
import {
  assetCompatibilityLabel,
  AssetSourceMetadata,
  assetSourceMetadataLabel,
} from "./asset-source-metadata";
import type { AssetStoragePresentation, AssetStorageStatus } from "./media-bin-model";
import { MediaSkimSurface } from "./media-skim-surface";
import { MediaTranscriptBadge } from "./media-transcript-badge";

const CELL_CLASS_NAME = "px-3 py-2.5";

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

interface MediaAssetCardProps {
  action?: ReactNode;
  asset: Asset;
  compact?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onDoubleClick?: MouseEventHandler<HTMLButtonElement>;
  onPreviewEnd?: () => void;
  onPreviewTime?: (sourceTimeUs: TimeUs) => void;
  previewDisabled?: boolean;
  selected?: boolean;
  storage: AssetStoragePresentation;
  storageDetail?: string | null;
}

function MediaAssetCorner({
  asset,
  compact,
  selected,
}: Pick<MediaAssetCardProps, "asset" | "selected"> & { compact: boolean }) {
  const badgeSize = compact ? "size-5" : "size-6";
  if (selected)
    return (
      <span
        className={`grid ${badgeSize} place-items-center rounded-full bg-accent text-on-accent shadow-md`}
      >
        <Check size={compact ? 11 : 14} strokeWidth={3} />
      </span>
    );
  const compatibility = assetCompatibilityLabel(asset);
  return compatibility ? (
    <span
      className={`grid ${badgeSize} place-items-center rounded-full bg-panel/90 text-amber-400 shadow-md`}
      title={compatibility}
    >
      <CircleAlert size={compact ? 11 : 14} />
    </span>
  ) : null;
}

function MediaAssetBadges({
  asset,
  compact,
  storage,
  storageDetail,
}: Pick<MediaAssetCardProps, "asset" | "storage" | "storageDetail"> & { compact: boolean }) {
  return (
    <div className={cn("flex items-center", compact ? "gap-1" : "gap-1.5")}>
      <MediaTranscriptBadge asset={asset} />
      <span
        className={cn(
          "flex items-center gap-1 rounded bg-panel/90 text-secondary",
          compact ? "px-1 py-0.5 text-[10px]" : "px-1.5 py-0.5 text-ui-xs",
        )}
        title={storageDetail ?? storage.label}
      >
        <StorageIcon status={storage.kind} />
        {!compact && storage.label}
      </span>
      <span
        className={cn(
          "rounded bg-panel/90 text-secondary tabular-nums",
          compact ? "px-1 py-0.5 text-[10px]" : "px-1.5 py-0.5 text-ui-xs",
        )}
      >
        {formatDuration(asset.durationUs)}
      </span>
    </div>
  );
}

function previewInteractionProps(props: MediaAssetCardProps) {
  return {
    ...(props.action === undefined ? {} : { action: props.action }),
    ...(props.onClick ? { onClick: props.onClick } : {}),
    ...(props.onDoubleClick ? { onDoubleClick: props.onDoubleClick } : {}),
    ...(props.selected === undefined ? {} : { selected: props.selected }),
  };
}

function skimInteractionProps(props: MediaAssetCardProps) {
  return {
    ...(props.previewDisabled === undefined ? {} : { disabled: props.previewDisabled }),
    ...(props.onPreviewTime ? { onPreviewTime: props.onPreviewTime } : {}),
    ...(props.onPreviewEnd ? { onPreviewEnd: props.onPreviewEnd } : {}),
  };
}

/** One asset-card presentation shared by every project workspace. */
export function MediaAssetCard(props: MediaAssetCardProps) {
  const { asset, selected, storage, storageDetail } = props;
  const compact = props.compact ?? false;
  return (
    <PreviewCard
      ariaLabel={`${selected === undefined ? "Add" : "Select"} ${asset.name}`}
      title="Select, double-click to add, or right-click for actions"
      {...(compact ? { size: "compact" as const } : { variant: "frameless" as const })}
      {...previewInteractionProps(props)}
      previewClassName="media-thumbnail"
      preview={<MediaSkimSurface asset={asset} {...skimInteractionProps(props)} />}
      corner={
        <MediaAssetCorner
          asset={asset}
          compact={compact}
          {...(selected === undefined ? {} : { selected })}
        />
      }
      bottomCorner={
        <MediaAssetBadges
          asset={asset}
          compact={compact}
          storage={storage}
          {...(storageDetail === undefined ? {} : { storageDetail })}
        />
      }
    >
      <p
        className={cn("truncate font-medium text-primary", compact ? "text-ui-xs" : "text-ui")}
        title={asset.name}
      >
        {asset.name}
      </p>
      <AssetSourceMetadata
        asset={asset}
        className={cn(
          "mt-0.5 truncate text-muted tabular-nums",
          compact ? "text-[10px]" : "text-ui-xs",
        )}
      />
    </PreviewCard>
  );
}

interface MediaAssetRowProps {
  asset: Asset;
  columnsClassName: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onDoubleClick: MouseEventHandler<HTMLButtonElement>;
  selected: boolean;
  storage: AssetStoragePresentation;
}

function kindLabel(kind: Asset["kind"]): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

/** One dense asset-row presentation shared with any list-oriented media surface. */
export function MediaAssetRow({
  asset,
  columnsClassName,
  onClick,
  onDoubleClick,
  selected,
  storage,
}: MediaAssetRowProps) {
  const compatibility = assetCompatibilityLabel(asset);
  return (
    <LibraryListRow
      data-asset-id={asset.id}
      columnsClassName={columnsClassName}
      selected={selected}
      aria-label={`Select ${asset.name}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
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
        <span className="min-w-0 flex-1 truncate font-medium text-primary">{asset.name}</span>
        <MediaTranscriptBadge asset={asset} />
      </div>
      <span className={CELL_CLASS_NAME}>{kindLabel(asset.kind)}</span>
      <span className={cn(CELL_CLASS_NAME, "tabular-nums")}>
        {formatDuration(asset.durationUs)}
      </span>
      <span className={cn(CELL_CLASS_NAME, "tabular-nums")}>
        <span title={compatibility ?? undefined}>
          {assetSourceMetadataLabel(asset) ?? "—"}
          {compatibility ? " · ⚠" : ""}
        </span>
      </span>
      <span className={cn(CELL_CLASS_NAME, "truncate text-muted")}>{storage.label}</span>
    </LibraryListRow>
  );
}

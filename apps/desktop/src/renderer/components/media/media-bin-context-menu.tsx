import { useState } from "react";
import type { ReactNode } from "react";
import { Film, HardDriveDownload, ListPlus, RotateCcw, Trash2, X } from "@cinesim/ui";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@cinesim/ui";
import type { AssetId } from "@cinesim/core";

type ContextMenuTarget = { kind: "assets" } | { kind: "sequence"; sequenceId: string };
type LocatedContextMenuTarget =
  | { kind: "assets"; assetId: AssetId }
  | { kind: "sequence"; sequenceId: string };

interface MediaBinContextMenuProps {
  children: ReactNode;
  cloudAssetId: AssetId | null;
  cloudOriginalDownloaded: boolean;
  hasProxyAssets: boolean;
  onClearSelection: () => void;
  onCreateTimeline: () => void;
  onGenerateProxies: () => void;
  onOpenTimeline: (sequenceId: string) => void;
  onRemoveAssets: () => void;
  onRemoveSequence: (sequenceId: string) => void;
  onRetryCloudTransfer: (assetId: AssetId) => void;
  onSelectOnly: (assetId: AssetId) => void;
  onToggleCloudOriginal: (assetId: AssetId) => void;
  retryAssetId: AssetId | null;
  selectedAssetIds: ReadonlySet<AssetId>;
  selectedCount: number;
}

function contextTarget(value: EventTarget): LocatedContextMenuTarget | null {
  if (!(value instanceof Element)) return null;
  const assetId = value.closest<HTMLElement>("[data-asset-id]")?.dataset.assetId as
    | AssetId
    | undefined;
  if (assetId) return { kind: "assets", assetId };
  const sequenceId = value.closest<HTMLElement>("[data-sequence-id]")?.dataset.sequenceId;
  return sequenceId ? { kind: "sequence", sequenceId } : null;
}

function AssetMenuItems(props: MediaBinContextMenuProps) {
  const assetLabel = props.selectedCount === 1 ? "Asset" : "Assets";
  return (
    <>
      <ContextMenuItem onClick={props.onCreateTimeline}>
        <ListPlus size={14} /> Create Timeline from {props.selectedCount} {assetLabel}
      </ContextMenuItem>
      {props.hasProxyAssets && (
        <ContextMenuItem onClick={props.onGenerateProxies}>
          <Film size={14} /> Generate edit {props.selectedCount === 1 ? "proxy" : "proxies"}
        </ContextMenuItem>
      )}
      {props.retryAssetId && (
        <ContextMenuItem onClick={() => props.onRetryCloudTransfer(props.retryAssetId!)}>
          <RotateCcw size={14} /> Retry cloud upload
        </ContextMenuItem>
      )}
      {props.cloudAssetId && (
        <ContextMenuItem onClick={() => props.onToggleCloudOriginal(props.cloudAssetId!)}>
          {props.cloudOriginalDownloaded ? (
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
      <ContextMenuItem onClick={props.onRemoveAssets}>
        <Trash2 size={14} /> Remove {props.selectedCount} {assetLabel} from Project
      </ContextMenuItem>
      <ContextMenuItem onClick={props.onClearSelection}>
        <X size={14} /> Clear Selection
      </ContextMenuItem>
    </>
  );
}

function SequenceMenuItems({
  sequenceId,
  onOpenTimeline,
  onRemoveSequence,
}: Pick<MediaBinContextMenuProps, "onOpenTimeline" | "onRemoveSequence"> & {
  sequenceId: string;
}) {
  return (
    <>
      <ContextMenuItem onClick={() => onOpenTimeline(sequenceId)}>
        <Film size={14} /> Open Timeline
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onRemoveSequence(sequenceId)}>
        <Trash2 size={14} /> Delete Timeline
      </ContextMenuItem>
    </>
  );
}

function MenuItems({
  target,
  ...props
}: MediaBinContextMenuProps & { target: ContextMenuTarget | null }) {
  if (target?.kind === "assets") return <AssetMenuItems {...props} />;
  return target?.kind === "sequence" ? (
    <SequenceMenuItems {...props} sequenceId={target.sequenceId} />
  ) : null;
}

export function MediaBinContextMenu(props: MediaBinContextMenuProps) {
  const { children, onSelectOnly, selectedAssetIds } = props;
  const [target, setTarget] = useState<ContextMenuTarget | null>(null);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="contents"
        onContextMenu={(event) => {
          const located = contextTarget(event.target);
          if (located?.kind === "assets") {
            if (!selectedAssetIds.has(located.assetId)) onSelectOnly(located.assetId);
            setTarget({ kind: "assets" });
            return;
          }
          if (located?.kind === "sequence") {
            setTarget(located);
            return;
          }
          event.preventBaseUIHandler();
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64" positionerClassName="z-[90]">
        <MenuItems {...props} target={target} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

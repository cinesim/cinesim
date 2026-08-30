import { useState } from "react";
import type { ReactNode } from "react";
import { Film, HardDriveDownload, ListPlus, RotateCcw, Trash2, X } from "@cinesim/ui";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@cinesim/ui";
import type { AssetId } from "@cinesim/core";

type ContextMenuTarget = { kind: "assets" } | { kind: "sequence"; sequenceId: string };

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

export function MediaBinContextMenu({
  children,
  cloudAssetId,
  cloudOriginalDownloaded,
  hasProxyAssets,
  onClearSelection,
  onCreateTimeline,
  onGenerateProxies,
  onOpenTimeline,
  onRemoveAssets,
  onRemoveSequence,
  onRetryCloudTransfer,
  onSelectOnly,
  onToggleCloudOriginal,
  retryAssetId,
  selectedAssetIds,
  selectedCount,
}: MediaBinContextMenuProps) {
  const [target, setTarget] = useState<ContextMenuTarget | null>(null);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="contents"
        onContextMenu={(event) => {
          const element = event.target instanceof Element ? event.target : null;
          const assetId = element?.closest<HTMLElement>("[data-asset-id]")?.dataset.assetId as
            | AssetId
            | undefined;
          if (assetId) {
            if (!selectedAssetIds.has(assetId)) onSelectOnly(assetId);
            setTarget({ kind: "assets" });
            return;
          }
          const sequenceId =
            element?.closest<HTMLElement>("[data-sequence-id]")?.dataset.sequenceId;
          if (sequenceId) {
            setTarget({ kind: "sequence", sequenceId });
            return;
          }
          event.preventBaseUIHandler();
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64" positionerClassName="z-[90]">
        {target?.kind === "assets" ? (
          <>
            <ContextMenuItem onClick={onCreateTimeline}>
              <ListPlus size={14} /> Create Timeline from {selectedCount}{" "}
              {selectedCount === 1 ? "Asset" : "Assets"}
            </ContextMenuItem>
            {hasProxyAssets && (
              <ContextMenuItem onClick={onGenerateProxies}>
                <Film size={14} /> Generate edit {selectedCount === 1 ? "proxy" : "proxies"}
              </ContextMenuItem>
            )}
            {retryAssetId && (
              <ContextMenuItem onClick={() => onRetryCloudTransfer(retryAssetId)}>
                <RotateCcw size={14} /> Retry cloud upload
              </ContextMenuItem>
            )}
            {cloudAssetId && (
              <ContextMenuItem onClick={() => onToggleCloudOriginal(cloudAssetId)}>
                {cloudOriginalDownloaded ? (
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
            <ContextMenuItem onClick={onRemoveAssets}>
              <Trash2 size={14} /> Remove {selectedCount} {selectedCount === 1 ? "Asset" : "Assets"}{" "}
              from Project
            </ContextMenuItem>
            <ContextMenuItem onClick={onClearSelection}>
              <X size={14} /> Clear Selection
            </ContextMenuItem>
          </>
        ) : target?.kind === "sequence" ? (
          <>
            <ContextMenuItem onClick={() => onOpenTimeline(target.sequenceId)}>
              <Film size={14} /> Open Timeline
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRemoveSequence(target.sequenceId)}>
              <Trash2 size={14} /> Delete Timeline
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

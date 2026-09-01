import { useState } from "react";
import type { ReactNode } from "react";
import {
  Film,
  FolderOpen,
  HardDriveDownload,
  ListPlus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "@cinesim/ui";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@cinesim/ui";
import type { AssetId } from "@cinesim/core";

type ContextMenuTarget = { kind: "assets" } | { kind: "sequence"; sequenceId: string };
type LocatedContextMenuTarget =
  | { kind: "assets"; assetId: AssetId }
  | { kind: "sequence"; sequenceId: string };

export interface MediaAssetMenuProps {
  canRevealAsset: boolean;
  cloudAssetId: AssetId | null;
  cloudOriginalDownloaded: boolean;
  hasProxyAssets: boolean;
  onClearSelection?: () => void;
  onCreateTimeline: () => void;
  onGenerateProxies: () => void;
  onRemoveAssets?: () => void;
  onRetryCloudTransfer: (assetId: AssetId) => void;
  onRevealAsset: () => void;
  onToggleCloudOriginal: (assetId: AssetId) => void;
  onTranscriptAction: () => void;
  retryAssetId: AssetId | null;
  selectedCount: number;
  timelineActionLabel?: string;
  transcriptAction: "generate" | "regenerate" | "cancel" | null;
  transcriptionAvailable: boolean;
}

interface MediaBinContextMenuProps extends MediaAssetMenuProps {
  children: ReactNode;
  onOpenTimeline: (sequenceId: string) => void;
  onRemoveSequence: (sequenceId: string) => void;
  onSelectOnly: (assetId: AssetId) => void;
  selectedAssetIds: ReadonlySet<AssetId>;
}

const transcriptActionLabels = {
  generate: "Generate transcript",
  regenerate: "Regenerate transcript",
  cancel: "Cancel transcription",
} as const;

function contextTarget(value: EventTarget): LocatedContextMenuTarget | null {
  if (!(value instanceof Element)) return null;
  const assetId = value.closest<HTMLElement>("[data-asset-id]")?.dataset.assetId as
    | AssetId
    | undefined;
  if (assetId) return { kind: "assets", assetId };
  const sequenceId = value.closest<HTMLElement>("[data-sequence-id]")?.dataset.sequenceId;
  return sequenceId ? { kind: "sequence", sequenceId } : null;
}

export function MediaAssetMenuItems(props: MediaAssetMenuProps) {
  const assetLabel = props.selectedCount === 1 ? "Asset" : "Assets";
  return (
    <>
      <ContextMenuItem onClick={props.onCreateTimeline}>
        <ListPlus size={14} />
        {props.timelineActionLabel ?? `Create Timeline from ${props.selectedCount} ${assetLabel}`}
      </ContextMenuItem>
      {props.hasProxyAssets && (
        <ContextMenuItem onClick={props.onGenerateProxies}>
          <Film size={14} /> Generate edit {props.selectedCount === 1 ? "proxy" : "proxies"}
        </ContextMenuItem>
      )}
      {props.transcriptAction && (
        <ContextMenuItem
          disabled={props.transcriptAction !== "cancel" && !props.transcriptionAvailable}
          onClick={props.onTranscriptAction}
        >
          <Sparkles size={14} /> {transcriptActionLabels[props.transcriptAction]}
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
      {props.canRevealAsset && (
        <ContextMenuItem onClick={props.onRevealAsset}>
          <FolderOpen size={14} /> Reveal source in Finder
        </ContextMenuItem>
      )}
      {props.onRemoveAssets && (
        <ContextMenuItem onClick={props.onRemoveAssets}>
          <Trash2 size={14} /> Remove {props.selectedCount} {assetLabel} from Project
        </ContextMenuItem>
      )}
      {props.onClearSelection && (
        <ContextMenuItem onClick={props.onClearSelection}>
          <X size={14} /> Clear Selection
        </ContextMenuItem>
      )}
    </>
  );
}

export function MediaAssetContextMenu({
  children,
  ...props
}: MediaAssetMenuProps & { children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64" positionerClassName="z-[90]">
        <MediaAssetMenuItems {...props} />
      </ContextMenuContent>
    </ContextMenu>
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
  if (target?.kind === "assets") return <MediaAssetMenuItems {...props} />;
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

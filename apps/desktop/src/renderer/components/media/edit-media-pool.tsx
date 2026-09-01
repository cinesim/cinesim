import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CircleAlert, Cloud, Film, Plus } from "@cinesim/ui";
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
  PaneHeader,
  PreviewCard,
  SearchField,
} from "@cinesim/ui";
import type { Asset, Project } from "@cinesim/core";
import { formatDuration } from "../../lib/format";
import { useRendererStore } from "../../store/renderer-store-context";
import { useEditorDnd } from "../workspace/editor-dnd-context";
import { useEditorTransport } from "../workspace/editor-transport-context";
import { assetCompatibilityLabel, AssetSourceMetadata } from "./asset-source-metadata";
import { MediaSkimSurface } from "./media-skim-surface";
import { MediaTranscriptBadge } from "./media-transcript-badge";

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
  const compatibility = assetCompatibilityLabel(asset);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `asset:${asset.id}`,
    data: { kind: "asset", assetId: asset.id },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={isDragging ? "opacity-45" : undefined}
    >
      <PreviewCard
        ariaLabel={`Add ${asset.name} to the active timeline`}
        title="Double-click to add to the active timeline"
        size="compact"
        previewClassName="media-thumbnail"
        preview={
          <MediaSkimSurface
            asset={asset}
            disabled={editorDrag.dragging}
            onPreviewTime={(sourceTimeUs) => transport.previewAsset(asset.id, sourceTimeUs)}
            onPreviewEnd={() => void transport.exitAssetPreview()}
          />
        }
        bottomCorner={
          <div className="flex items-center gap-1">
            {compatibility && (
              <span
                className="grid size-5 place-items-center rounded bg-panel/90 text-amber-400"
                title={compatibility}
              >
                <CircleAlert size={11} />
              </span>
            )}
            {asset.source.kind === "cloud" && (
              <span
                className="grid size-5 place-items-center rounded bg-panel/90 text-secondary"
                title="Cloud original"
              >
                <Cloud size={10} />
              </span>
            )}
            <span className="rounded bg-panel/90 px-1 py-0.5 text-[10px] tabular-nums text-secondary">
              {formatDuration(asset.durationUs)}
            </span>
          </div>
        }
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
      >
        <p className="truncate text-ui-xs font-medium text-primary" title={asset.name}>
          {asset.name}
        </p>
        <p className="edit-media-card-secondary mt-0.5 truncate text-[10px] text-muted tabular-nums">
          {asset.id}
        </p>
        <AssetSourceMetadata
          asset={asset}
          className="edit-media-card-secondary mt-0.5 truncate text-[10px] text-muted tabular-nums"
        />
        <MediaTranscriptBadge asset={asset} className="mt-1" />
      </PreviewCard>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Film, Plus } from "lucide-react";
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
import { formatDuration } from "../lib/format";
import { MediaSkimSurface } from "./media-skim-surface";
import { useEditorDnd } from "../interactions/editor-dnd-context";

interface EditMediaPoolProps {
  project: Project;
  onAddAsset: (asset: Asset) => Promise<unknown>;
  onImport: () => Promise<unknown>;
  onPreviewAsset: (asset: Asset, sourceTimeUs: number) => void;
  onPreviewEnd: () => void;
}

export function EditMediaPool({
  project,
  onAddAsset,
  onImport,
  onPreviewAsset,
  onPreviewEnd,
}: EditMediaPoolProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const assets = useMemo(
    () => project.assets.filter((asset) => asset.name.toLowerCase().includes(normalizedQuery)),
    [normalizedQuery, project.assets],
  );

  return (
    <aside className="flex min-h-0 flex-col bg-panel">
      <PaneHeader size="sm">
        <SearchField
          size="sm"
          surface="muted"
          placeholder="Search media"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {assets.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-2">
            {assets.map((asset) => (
              <DraggableAssetCard
                key={asset.id}
                asset={asset}
                onAddAsset={onAddAsset}
                onPreviewAsset={onPreviewAsset}
                onPreviewEnd={onPreviewEnd}
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

      <div className="border-t border-border p-2">
        <Button className="w-full" variant="secondary" onClick={() => void onImport()}>
          Import media
        </Button>
      </div>
    </aside>
  );
}

function DraggableAssetCard({
  asset,
  onAddAsset,
  onPreviewAsset,
  onPreviewEnd,
}: {
  asset: Asset;
  onAddAsset: (asset: Asset) => Promise<unknown>;
  onPreviewAsset: (asset: Asset, sourceTimeUs: number) => void;
  onPreviewEnd: () => void;
}) {
  const editorDrag = useEditorDnd();
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
        badge={asset.kind}
        ariaLabel={`Add ${asset.name} to the active timeline`}
        title="Double-click to add to the active timeline"
        size="compact"
        previewClassName="media-thumbnail"
        preview={
          <MediaSkimSurface
            asset={asset}
            disabled={editorDrag.dragging}
            onPreviewTime={(sourceTimeUs) => onPreviewAsset(asset, sourceTimeUs)}
            onPreviewEnd={onPreviewEnd}
          />
        }
        bottomCorner={
          <span className="rounded bg-panel/90 px-1 py-0.5 text-[10px] tabular-nums text-secondary">
            {formatDuration(asset.durationUs)}
          </span>
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
        <p className="mt-0.5 truncate text-[10px] text-muted tabular-nums">{asset.id}</p>
      </PreviewCard>
    </div>
  );
}

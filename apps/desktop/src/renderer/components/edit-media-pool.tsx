import { useMemo, useState } from "react";
import { Film, Plus, Search } from "lucide-react";
import { Button } from "@cinesim/ui";
import type { Asset, Project } from "@cinesim/core";
import { formatDuration } from "../lib/format";
import { LibraryCard } from "./library-card";
import { MediaSkimSurface } from "./media-skim-surface";

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
      <div className="flex h-10 shrink-0 items-center border-b border-border px-2">
        <div className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-panel-muted px-2 text-muted">
          <Search size={12} />
          <input
            className="min-w-0 flex-1 bg-transparent text-ui-xs text-secondary outline-none placeholder:text-muted"
            placeholder="Search media"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {assets.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-2">
            {assets.map((asset) => (
              <LibraryCard
                key={asset.id}
                badge={asset.kind}
                ariaLabel={`Add ${asset.name} to the active timeline`}
                title="Double-click to add to the active timeline"
                size="compact"
                previewClassName="media-thumbnail"
                preview={
                  <MediaSkimSurface
                    asset={asset}
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
              </LibraryCard>
            ))}
          </div>
        ) : normalizedQuery ? (
          <p className="px-2 py-8 text-center text-ui-xs text-muted">Nothing matches “{query}”.</p>
        ) : (
          <div className="px-2 py-8 text-center">
            <Film className="mx-auto mb-2 text-disabled" size={21} />
            <p className="text-ui text-muted">No media yet</p>
            <p className="mt-1 text-ui-xs text-muted">Import media to start assembling this cut.</p>
          </div>
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

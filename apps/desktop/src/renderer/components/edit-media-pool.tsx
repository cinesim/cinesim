import { useMemo, useState } from "react";
import { Film, Plus, Search } from "lucide-react";
import { Button } from "@cinesim/ui";
import type { Asset, Project } from "@cinesim/core";
import { formatDuration } from "../lib/format";
import { MediaSkimSurface } from "./media-skim-surface";

interface EditMediaPoolProps {
  project: Project;
  onAddAsset: (asset: Asset) => Promise<void>;
  onImport: () => Promise<void>;
}

export function EditMediaPool({ project, onAddAsset, onImport }: EditMediaPoolProps) {
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
          <div className="space-y-1">
            {assets.map((asset) => (
              <div
                key={asset.id}
                className="group flex min-w-0 items-center gap-1 rounded-md border border-transparent p-1 hover:border-border hover:bg-surface"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  aria-label={`Add ${asset.name} to the active timeline`}
                  title="Double-click to add to the active timeline"
                  onDoubleClick={() => void onAddAsset(asset)}
                >
                  <span className="media-thumbnail grid size-10 shrink-0 place-items-center overflow-hidden rounded border border-border text-muted">
                    <MediaSkimSurface asset={asset} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-xs font-medium text-primary">
                      {asset.name}
                    </span>
                    <span className="mt-0.5 block text-[10px] capitalize text-muted tabular-nums">
                      {asset.kind} · {formatDuration(asset.durationUs)}
                    </span>
                  </span>
                </button>
                <Button
                  className="shrink-0 opacity-60 group-hover:opacity-100"
                  size="icon"
                  variant="ghost"
                  aria-label={`Add ${asset.name} to the active timeline`}
                  title="Add to active timeline"
                  onClick={() => void onAddAsset(asset)}
                >
                  <Plus size={13} />
                </Button>
              </div>
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, Film } from "lucide-react";
import { Button, Kbd, PaneHeader, PreviewCard, SearchField } from "@cinesim/ui";
import { sequenceDurationUs } from "@cinesim/core";
import type { Asset, Project } from "@cinesim/core";
import { formatDuration } from "../../lib/format";
import { useRendererStore } from "../../store/renderer-store-context";
import { LibraryGrid } from "../shared/library-card";
import { MediaSkimSurface } from "./media-skim-surface";

interface MediaBinProps {
  project: Project;
  onOpenTimeline: (sequenceId: string) => void;
}

export function MediaBin({ project, onOpenTimeline }: MediaBinProps) {
  const [query, setQuery] = useState("");
  const modifier = window.cinesim.platform === "darwin" ? "⌘" : "Ctrl+";
  const normalizedQuery = query.trim().toLowerCase();
  const sequences = useMemo(
    () =>
      project.sequences.filter((sequence) => sequence.name.toLowerCase().includes(normalizedQuery)),
    [normalizedQuery, project.sequences],
  );
  const assets = useMemo(
    () => project.assets.filter((asset) => asset.name.toLowerCase().includes(normalizedQuery)),
    [normalizedQuery, project.assets],
  );

  const importProjectMedia = useRendererStore((state) => state.importMedia);
  const appendAsset = useRendererStore((state) => state.appendAsset);
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const importMedia = useCallback(async () => importProjectMedia(), [importProjectMedia]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        void importMedia();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [importMedia]);

  async function addToTimeline(asset: Asset) {
    await appendAsset(asset.id, activeSequenceId ?? project.activeSequenceId);
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas">
      <PaneHeader size="lg" className="gap-3">
        <SearchField
          className="min-w-52 max-w-sm flex-1"
          placeholder="Search media and timelines"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="ml-auto text-ui-xs text-muted">
          {project.sequences.length + project.assets.length} items
        </span>
        <Button onClick={() => void importMedia()}>
          Import media
          <Kbd className="ml-1 px-1">{modifier}I</Kbd>
        </Button>
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <LibraryGrid>
          {sequences.map((sequence) => (
            <PreviewCard
              key={sequence.id}
              badge="Timeline"
              ariaLabel={`Open ${sequence.name}`}
              title="Double-click to open timeline"
              previewClassName="timeline-thumbnail"
              preview={<Film size={25} strokeWidth={1.5} />}
              bottomCorner={
                <span className="rounded bg-panel/90 px-1.5 py-0.5 text-ui-xs tabular-nums text-secondary">
                  {formatDuration(sequenceDurationUs(sequence))}
                </span>
              }
              onDoubleClick={() => onOpenTimeline(sequence.id)}
            >
              <p className="truncate text-ui font-medium text-primary">{sequence.name}</p>
              <p className="mt-1 flex items-center gap-1 text-ui-xs text-muted">
                <Clock3 size={11} /> {sequence.frameRate} fps · {sequence.width} × {sequence.height}
              </p>
            </PreviewCard>
          ))}

          {assets.map((asset) => (
            <PreviewCard
              key={asset.id}
              badge={asset.kind}
              ariaLabel={`Add ${asset.name} to the active timeline`}
              title="Double-click to add to the active timeline"
              previewClassName="media-thumbnail"
              preview={<MediaSkimSurface asset={asset} />}
              bottomCorner={
                <span className="rounded bg-panel/90 px-1.5 py-0.5 text-ui-xs tabular-nums text-secondary">
                  {formatDuration(asset.durationUs)}
                </span>
              }
              onDoubleClick={() => void addToTimeline(asset)}
            >
              <p className="truncate text-ui font-medium text-primary" title={asset.name}>
                {asset.name}
              </p>
              <p className="mt-1 truncate text-ui-xs text-muted tabular-nums">{asset.id}</p>
            </PreviewCard>
          ))}

          {normalizedQuery && sequences.length === 0 && assets.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-border-strong px-5 py-10 text-center text-ui text-muted">
              Nothing matches “{query}”.
            </div>
          )}
        </LibraryGrid>
      </div>
    </section>
  );
}

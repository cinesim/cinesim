import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, Film, Image as ImageIcon, Music2, Plus, Search } from "lucide-react";
import { Button } from "@cinesim/ui";
import { getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Asset, Project } from "@cinesim/core";
import type { DesktopProjectSession } from "../../shared/api";
import { formatDuration } from "../lib/format";
import { LibraryCard, LibraryGrid } from "./library-card";

interface MediaBinProps {
  project: Project;
  onSession: (session: DesktopProjectSession) => void;
  onOpenTimeline: (sequenceId: string) => void;
}

function KindIcon({ asset }: { asset: Asset }) {
  if (asset.kind === "audio") return <Music2 size={21} />;
  if (asset.kind === "image") return <ImageIcon size={21} />;
  return <Film size={21} />;
}

export function MediaBin({ project, onSession, onOpenTimeline }: MediaBinProps) {
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

  const importMedia = useCallback(async () => {
    const session = await window.cinesim.importMedia();
    if (session) onSession(session);
  }, [onSession]);

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
    const sequence = getSequence(project);
    const track = sequence.tracks.find(
      (candidate) => candidate.kind === (asset.kind === "audio" ? "audio" : "video"),
    );
    if (!track) return;
    const timelineStartUs = sequenceDurationUs(sequence);
    const response = await window.cinesim.execute({
      type: "clip.add",
      trackId: track.id,
      assetId: asset.id,
      timelineStartUs,
    });
    onSession(response.session);
  }

  return (
    <section className="flex min-h-0 flex-col bg-canvas">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <div className="flex h-8 min-w-52 max-w-sm flex-1 items-center gap-2 rounded-md border border-border bg-panel px-2.5 text-muted">
          <Search size={13} />
          <input
            className="min-w-0 flex-1 bg-transparent text-ui text-secondary outline-none placeholder:text-muted"
            placeholder="Search media and timelines"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="ml-auto text-ui-xs text-muted">
          {project.sequences.length + project.assets.length} items
        </span>
        <Button onClick={() => void importMedia()}>
          Import media
          <kbd className="ml-1 rounded border border-border-strong bg-panel-muted px-1 py-0.5 text-[10px] font-medium text-muted">
            {modifier}I
          </kbd>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <LibraryGrid>
          {sequences.map((sequence) => (
            <LibraryCard
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
            </LibraryCard>
          ))}

          {assets.map((asset) => (
            <LibraryCard
              key={asset.id}
              badge={asset.kind}
              ariaLabel={`Add ${asset.name} to the default timeline`}
              title="Double-click to add to the default timeline"
              previewClassName="media-thumbnail"
              preview={
                <>
                  <KindIcon asset={asset} />
                  <span className="absolute inset-0 grid place-items-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="grid size-8 place-items-center rounded-full bg-accent text-on-accent">
                      <Plus size={15} />
                    </span>
                  </span>
                </>
              }
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
            </LibraryCard>
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

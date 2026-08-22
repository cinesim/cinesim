import { Film, Import, Music2, Plus, Search, Image as ImageIcon } from "lucide-react";
import { Button } from "@cinesim/ui";
import { getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Asset, Project } from "@cinesim/core";
import type { DesktopProjectSession } from "../../shared/api";
import { formatDuration } from "../lib/format";

interface MediaBinProps {
  project: Project;
  onSession: (session: DesktopProjectSession) => void;
}

function KindIcon({ asset }: { asset: Asset }) {
  if (asset.kind === "audio") return <Music2 size={18} />;
  if (asset.kind === "image") return <ImageIcon size={18} />;
  return <Film size={18} />;
}

export function MediaBin({ project, onSession }: MediaBinProps) {
  async function importMedia() {
    const session = await window.cinesim.importMedia();
    if (session) onSession(session);
  }

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
    <aside className="flex min-h-0 flex-col border-r border-border bg-panel">
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <span className="panel-title">Media</span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Import media"
          onClick={() => void importMedia()}
        >
          <Import size={14} />
        </Button>
      </div>
      <div className="m-2 flex h-8 items-center gap-2 rounded-md border border-border bg-panel-muted px-2 text-muted">
        <Search size={13} />
        <input
          className="min-w-0 flex-1 bg-transparent text-ui text-secondary outline-none placeholder:text-muted"
          placeholder="Search media"
        />
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-2 overflow-y-auto p-2 pt-0">
        {project.assets.map((asset) => (
          <article
            key={asset.id}
            className="group overflow-hidden rounded-lg border border-border bg-panel-muted hover:border-border-strong"
          >
            <button
              className="media-thumbnail relative grid aspect-video w-full place-items-center text-muted"
              onDoubleClick={() => void addToTimeline(asset)}
            >
              <KindIcon asset={asset} />
              <span className="absolute bottom-1 right-1 rounded bg-accent px-1 py-0.5 text-ui-xs text-on-accent tabular-nums">
                {formatDuration(asset.durationUs)}
              </span>
              <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                <span className="grid size-7 place-items-center rounded-full bg-accent text-on-accent">
                  <Plus size={14} />
                </span>
              </span>
            </button>
            <div className="p-2">
              <p className="truncate text-ui-xs font-medium text-secondary" title={asset.name}>
                {asset.name}
              </p>
              <p className="mt-0.5 truncate text-ui-xs text-muted tabular-nums">{asset.id}</p>
            </div>
          </article>
        ))}
        {project.assets.length === 0 && (
          <button
            className="col-span-2 m-2 grid min-h-36 place-items-center rounded-lg border border-dashed border-border-strong p-5 text-center hover:bg-surface"
            onClick={() => void importMedia()}
          >
            <span>
              <Import className="mx-auto mb-2 text-muted" size={22} />
              <span className="block text-ui text-secondary">Import your first shot</span>
              <span className="mt-1 block text-ui-xs text-muted">
                MP4, MOV, WebM, audio, or image
              </span>
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}

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
    <aside className="flex min-h-0 flex-col border-r border-white/[0.07] bg-[#101013]">
      <div className="flex h-10 items-center justify-between border-b border-white/[0.06] px-3">
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
      <div className="m-2 flex h-8 items-center gap-2 rounded-md border border-white/[0.07] bg-black/20 px-2 text-zinc-600">
        <Search size={13} />
        <input
          className="min-w-0 flex-1 bg-transparent text-xs text-zinc-300 outline-none placeholder:text-zinc-700"
          placeholder="Search media"
        />
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-2 overflow-y-auto p-2 pt-0">
        {project.assets.map((asset) => (
          <article
            key={asset.id}
            className="group overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.025] hover:border-violet-400/30"
          >
            <button
              className="relative grid aspect-video w-full place-items-center bg-[linear-gradient(145deg,#202029,#111115)] text-zinc-600"
              onDoubleClick={() => void addToTimeline(asset)}
            >
              <KindIcon asset={asset} />
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 font-mono text-[9px] text-zinc-400">
                {formatDuration(asset.durationUs)}
              </span>
              <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                <span className="grid size-7 place-items-center rounded-full bg-violet-500 text-white">
                  <Plus size={14} />
                </span>
              </span>
            </button>
            <div className="p-2">
              <p className="truncate text-[11px] font-medium text-zinc-300" title={asset.name}>
                {asset.name}
              </p>
              <p className="mt-0.5 truncate font-mono text-[9px] text-zinc-600">{asset.id}</p>
            </div>
          </article>
        ))}
        {project.assets.length === 0 && (
          <button
            className="col-span-2 m-2 grid min-h-36 place-items-center rounded-lg border border-dashed border-white/10 p-5 text-center hover:border-violet-400/30"
            onClick={() => void importMedia()}
          >
            <span>
              <Import className="mx-auto mb-2 text-zinc-700" size={22} />
              <span className="block text-xs text-zinc-500">Import your first shot</span>
              <span className="mt-1 block text-[10px] text-zinc-700">
                MP4, MOV, WebM, audio, or image
              </span>
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}

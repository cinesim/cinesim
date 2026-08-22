import { useEffect, useRef, useState } from "react";
import { Maximize2, Pause, Play, SkipBack } from "lucide-react";
import { Button } from "@cinesim/ui";
import { getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import { PlaybackRuntime, WebGpuCompositor } from "@cinesim/engine";
import { formatTimecode } from "../lib/format";
import { useUiStore } from "../store/ui-store";

export function Viewer({ project }: { project: Project }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<PlaybackRuntime | null>(null);
  const initialProjectRef = useRef(project);
  const [error, setError] = useState<string | null>(null);
  const runtime = useUiStore((state) => state.runtime);
  const setRuntime = useUiStore((state) => state.setRuntime);
  const playheadUs = useUiStore((state) => state.playheadUs);
  const sequence = getSequence(project);
  const durationUs = sequenceDurationUs(sequence);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const compositor = new WebGpuCompositor(canvas);
    const playback = new PlaybackRuntime(initialProjectRef.current, compositor);
    runtimeRef.current = playback;
    const unsubscribe = playback.subscribe(setRuntime);
    void compositor
      .initialize()
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "WebGPU initialization failed"),
      );
    return () => {
      unsubscribe();
      playback.destroy();
      compositor.destroy();
      runtimeRef.current = null;
    };
  }, [setRuntime]);

  useEffect(() => runtimeRef.current?.setProject(project), [project]);

  async function seek(value: number) {
    await runtimeRef.current?.seek(Math.round(value));
  }

  return (
    <section className="relative flex min-h-0 flex-col bg-[#0c0c0f]">
      <div className="flex h-10 items-center justify-between border-b border-white/[0.06] px-3">
        <span className="panel-title">Program</span>
        <span className="rounded bg-white/[0.04] px-2 py-1 font-mono text-[9px] text-zinc-500">
          {sequence.width} × {sequence.height} · {sequence.frameRate} fps
        </span>
      </div>
      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-[radial-gradient(circle_at_50%_45%,#24242d_0,#111116_48%,#08080a_100%)] p-6">
        <canvas
          ref={canvasRef}
          className="aspect-video max-h-full max-w-full bg-black shadow-2xl shadow-black"
        />
        {project.assets.length === 0 && (
          <div className="pointer-events-none absolute text-center">
            <p className="text-xs text-zinc-600">The viewer is ready</p>
            <p className="mt-1 text-[10px] text-zinc-700">
              Import media and add it to the timeline
            </p>
          </div>
        )}
        {error && (
          <div className="absolute bottom-3 max-w-md rounded-md border border-amber-400/20 bg-amber-950/80 px-3 py-2 text-[10px] text-amber-200">
            {error}
          </div>
        )}
      </div>
      <div className="grid h-12 grid-cols-[1fr_auto_1fr] items-center border-t border-white/[0.06] px-3">
        <span className="font-mono text-[11px] text-zinc-400">
          {formatTimecode(playheadUs, sequence.frameRate)}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Go to beginning"
            onClick={() => void seek(0)}
          >
            <SkipBack size={14} />
          </Button>
          <Button
            className="rounded-full"
            size="icon"
            variant="secondary"
            aria-label={runtime?.playing ? "Pause" : "Play"}
            onClick={() =>
              runtime?.playing ? runtimeRef.current?.pause() : runtimeRef.current?.play()
            }
          >
            {runtime?.playing ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play className="ml-0.5" size={15} fill="currentColor" />
            )}
          </Button>
        </div>
        <Button className="ml-auto" size="icon" variant="ghost" aria-label="Fullscreen viewer">
          <Maximize2 size={14} />
        </Button>
      </div>
      <input
        aria-label="Viewer playhead"
        className="viewer-scrubber absolute bottom-11 left-0 right-0 z-10 h-1 w-full cursor-ew-resize appearance-none bg-transparent"
        type="range"
        min={0}
        max={Math.max(1, durationUs)}
        value={Math.min(playheadUs, durationUs)}
        onChange={(event) => void seek(Number(event.target.value))}
      />
    </section>
  );
}

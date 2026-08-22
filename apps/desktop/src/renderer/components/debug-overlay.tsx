import { useUiStore } from "../store/ui-store";
import { formatTimecode } from "../lib/format";

export function DebugOverlay() {
  const show = useUiStore((state) => state.showDebug);
  const metrics = useUiStore((state) => state.runtime);
  if (!show || !metrics) return null;
  const rows = [
    ["Timeline", formatTimecode(metrics.timeUs)],
    ["Render FPS", metrics.renderFps],
    ["Dropped", metrics.droppedFrames],
    ["Decode queue", metrics.decodeQueueSize],
    ["Decoders", metrics.activeDecoders],
    ["Active clips", metrics.activeClips],
    ["Seek latency", `${metrics.seekLatencyMs.toFixed(1)} ms`],
    ["GPU submit", `${metrics.gpuFrameTimeMs.toFixed(2)} ms`],
    ["Preview", `${metrics.previewWidth}×${metrics.previewHeight}`],
  ];
  return (
    <div className="pointer-events-none absolute right-3 top-14 z-50 w-48 rounded-lg border border-violet-400/20 bg-black/85 p-2.5 font-mono text-[10px] shadow-2xl backdrop-blur">
      <p className="mb-2 text-[9px] uppercase tracking-widest text-violet-300">Runtime metrics</p>
      {rows.map(([label, value]) => (
        <div className="flex justify-between py-0.5" key={label}>
          <span className="text-zinc-600">{label}</span>
          <span className="text-zinc-300">{value}</span>
        </div>
      ))}
    </div>
  );
}

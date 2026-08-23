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
    ["Frame operations", metrics.frameOperationsInFlight],
    ["Sources", metrics.activeSources],
    ["Active clips", metrics.activeClips],
    ["Seek latency", `${metrics.seekLatencyMs.toFixed(1)} ms`],
    ["GPU submit", `${metrics.gpuSubmitCpuMs.toFixed(2)} ms`],
    ["Preview", `${metrics.previewWidth}×${metrics.previewHeight}`],
  ];
  return (
    <div className="pointer-events-none absolute right-3 top-14 z-50 w-48 rounded-lg border border-border-strong bg-panel/90 p-2.5 text-ui-xs shadow-2xl backdrop-blur tabular-nums">
      <p className="mb-2 text-ui-xs uppercase tracking-widest text-primary">Runtime metrics</p>
      {rows.map(([label, value]) => (
        <div className="flex justify-between py-0.5" key={label}>
          <span className="text-muted">{label}</span>
          <span className="text-secondary">{value}</span>
        </div>
      ))}
    </div>
  );
}

import { Activity, Cpu, Database, Gauge, Image, Sparkles } from "lucide-react";
import { formatTimecode } from "../lib/format";
import { useUiStore } from "../store/ui-store";

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-1 text-ui-xs">
      <dt className="truncate text-muted">{label}</dt>
      <dd className="shrink-0 text-right text-secondary tabular-nums">{value}</dd>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border px-3 py-3">
      <h3 className="mb-2 flex items-center gap-2 text-ui-xs font-semibold uppercase tracking-[0.12em] text-muted">
        {icon}
        {title}
      </h3>
      <dl>{children}</dl>
    </section>
  );
}

const unavailable = <span className="text-disabled">Unavailable</span>;

export function MetricsSidebar() {
  const metrics = useUiStore((state) => state.runtime);
  const derived = useUiStore((state) => state.derivedMedia);
  const artifacts = derived ? Object.values(derived.assets) : [];
  const activeDerived = metrics?.activeAssetId ? derived?.assets[metrics.activeAssetId] : undefined;
  const readyCount = (kind: "thumbnail" | "filmstrip" | "proxy") =>
    artifacts.filter((asset) => asset[kind].state === "ready").length;

  return (
    <aside className="flex h-full min-h-0 flex-col bg-panel" aria-label="Metrics">
      <div className="flex h-12 shrink-0 items-center border-b border-border px-3">
        <Activity size={15} className="mr-2 text-muted" />
        <h2 className="text-ui font-medium text-primary">Metrics</h2>
        <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          Local
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section icon={<Gauge size={13} />} title="Overview">
          <MetricRow label="Preview mode" value={metrics?.mode.kind ?? unavailable} />
          <MetricRow label="Transport" value={metrics?.playing ? "Playing" : "Paused"} />
          <MetricRow label="Timeline" value={formatTimecode(metrics?.timeUs ?? 0)} />
          <MetricRow label="Foreground" value={metrics?.foregroundPressure ?? "Idle"} />
          <MetricRow label="Active asset" value={metrics?.activeAssetId ?? "None"} />
          <MetricRow label="Source" value={metrics?.activeSourceKind ?? unavailable} />
          <MetricRow
            label="Adaptive decision"
            value={activeDerived?.performance.decision ?? unavailable}
          />
          <MetricRow
            label="Decision reason"
            value={activeDerived?.performance.reasons.join(", ") || unavailable}
          />
          <MetricRow label="Background job" value={derived?.jobs.running ? "Running" : "None"} />
        </Section>

        <Section icon={<Activity size={13} />} title="Playback & scrubbing">
          <MetricRow label="Render FPS" value={metrics?.renderFps ?? 0} />
          <MetricRow label="Target FPS" value={metrics?.targetFps ?? 0} />
          <MetricRow
            label="Seek latency"
            value={`${(metrics?.seekLatencyMs ?? 0).toFixed(1)} ms`}
          />
          <MetricRow
            label="Original seek p95"
            value={
              activeDerived?.performance.original.warmSeekP95Ms === undefined
                ? unavailable
                : `${activeDerived.performance.original.warmSeekP95Ms.toFixed(1)} ms`
            }
          />
          <MetricRow
            label="Proxy seek p95"
            value={
              activeDerived?.performance.proxy?.warmSeekP95Ms === undefined
                ? unavailable
                : `${activeDerived.performance.proxy.warmSeekP95Ms.toFixed(1)} ms`
            }
          />
          <MetricRow label="Dropped frames" value={metrics?.droppedFrames ?? 0} />
          <MetricRow label="Requests" value={metrics?.requestsReceived ?? 0} />
          <MetricRow label="Coalesced" value={metrics?.requestsCoalesced ?? 0} />
          <MetricRow label="Presented" value={metrics?.framesPresented ?? 0} />
          <MetricRow label="Obsolete" value={metrics?.framesObsolete ?? 0} />
          <MetricRow label="In flight" value={metrics?.frameOperationsInFlight ?? 0} />
          <MetricRow label="Newest pending" value={metrics?.newestRequestPending ? "Yes" : "No"} />
          <MetricRow label="Active sources" value={metrics?.activeSources ?? 0} />
          <MetricRow label="Takeover suppressed" value={metrics?.sourcePreviewSuppressions ?? 0} />
        </Section>

        <Section icon={<Cpu size={13} />} title="GPU">
          <MetricRow label="CPU submit" value={`${(metrics?.gpuSubmitCpuMs ?? 0).toFixed(2)} ms`} />
          <MetricRow label="Submitted frames" value={metrics?.gpuSubmittedFrames ?? 0} />
          <MetricRow label="Device loss" value={metrics?.gpuDeviceLostCount ?? 0} />
          <MetricRow
            label="Output"
            value={metrics ? `${metrics.previewWidth}×${metrics.previewHeight}` : unavailable}
          />
          <MetricRow label="GPU execution" value={unavailable} />
        </Section>

        <Section icon={<Image size={13} />} title="Derived artifacts">
          <MetricRow label="Thumbnails" value={`${readyCount("thumbnail")}/${artifacts.length}`} />
          <MetricRow label="Filmstrips" value={`${readyCount("filmstrip")}/${artifacts.length}`} />
          <MetricRow label="Proxies" value={`${readyCount("proxy")}/${artifacts.length}`} />
          <MetricRow
            label="Jobs"
            value={
              derived
                ? `${derived.jobs.running} running · ${derived.jobs.queued} queued`
                : unavailable
            }
          />
          <MetricRow label="Failed" value={derived?.jobs.failed ?? 0} />
        </Section>

        <Section icon={<Database size={13} />} title="Storage">
          <MetricRow label="Derived bytes" value={formatBytes(derived?.storage.totalBytes)} />
          <MetricRow label="Budget" value={formatBytes(derived?.storage.budgetBytes)} />
          <MetricRow
            label="Safety reserve"
            value={formatBytes(derived?.storage.safetyReserveBytes)}
          />
          <MetricRow label="Evictions" value={derived?.storage.evictionCount ?? 0} />
        </Section>

        <Section icon={<Sparkles size={13} />} title="Decision log">
          {derived?.decisionLog.length ? (
            <ol className="space-y-2">
              {derived.decisionLog
                .slice(-20)
                .reverse()
                .map((event) => (
                  <li
                    key={`${event.at}-${event.kind}`}
                    className="rounded-md border border-border bg-panel-muted p-2"
                  >
                    <p className="text-ui-xs text-secondary">{event.detail}</p>
                    <p className="mt-1 text-[10px] text-muted">{event.kind}</p>
                  </li>
                ))}
            </ol>
          ) : (
            <div className="rounded-md border border-border bg-panel-muted px-2 py-3 text-center text-ui-xs text-muted">
              Adaptive decisions will appear here as media is observed.
            </div>
          )}
        </Section>
      </div>
    </aside>
  );
}

function formatBytes(value: number | undefined): React.ReactNode {
  if (value === undefined) return unavailable;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

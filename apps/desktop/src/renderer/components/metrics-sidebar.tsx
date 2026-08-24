import { Activity, Cpu, Database, Gauge, Image, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
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
  definitionList = true,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  definitionList?: boolean;
}) {
  return (
    <section className="border-b border-border px-3 py-3">
      <h3 className="mb-2 flex items-center gap-2 text-ui-xs font-semibold uppercase tracking-[0.12em] text-muted">
        {icon}
        {title}
      </h3>
      {definitionList ? <dl>{children}</dl> : children}
    </section>
  );
}

const unavailable = <span className="text-disabled">Unavailable</span>;

export function MetricsSidebar() {
  const metrics = useUiStore((state) => state.runtime);
  const derived = useUiStore((state) => state.derivedMedia);
  const artifacts = derived ? Object.values(derived.assets) : [];
  const background = derived?.runtime;
  const activeJob = background?.activeJob;
  const activeDerived = metrics?.activeAssetId ? derived?.assets[metrics.activeAssetId] : undefined;
  const decisionLogRef = useRef<HTMLOListElement>(null);
  const latestDecisionAt = derived?.decisionLog.at(-1)?.at;
  const readyCount = (kind: "thumbnail" | "filmstrip" | "proxy") =>
    artifacts.filter((asset) => asset[kind].state === "ready").length;

  useEffect(() => {
    const log = decisionLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [latestDecisionAt]);

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

        <Section icon={<Activity size={13} />} title="Background media">
          <MetricRow label="Asset" value={activeJob?.assetId ?? "None"} />
          <MetricRow label="Job kind" value={activeJob?.jobKind ?? unavailable} />
          <MetricRow label="Stage" value={activeJob?.stage ?? "Idle"} />
          <MetricRow
            label="Progress"
            value={activeJob ? `${Math.round(activeJob.progress * 100)}%` : unavailable}
          />
          <MetricRow
            label="Samples"
            value={
              activeJob?.totalSamples === undefined
                ? unavailable
                : `${activeJob.completedSamples ?? 0}/${activeJob.totalSamples}`
            }
          />
          <MetricRow
            label="Worker elapsed"
            value={activeJob ? formatDuration(activeJob.elapsedMs) : unavailable}
          />
          <MetricRow label="Last result" value={background?.lastJob?.stage ?? unavailable} />
          <MetricRow
            label="Last duration"
            value={
              background?.lastJob ? formatDuration(background.lastJob.durationMs) : unavailable
            }
          />
          <MetricRow label="Protocol requests" value={background?.protocol.requests ?? 0} />
          <MetricRow label="Range requests" value={background?.protocol.rangeRequests ?? 0} />
          <MetricRow label="Protocol bytes" value={formatBytes(background?.protocol.bytesRead)} />
          <MetricRow
            label="Average read"
            value={`${(background?.protocol.averageLatencyMs ?? 0).toFixed(2)} ms`}
          />
          <MetricRow
            label="Last read"
            value={
              background?.protocol.lastLatencyMs === undefined
                ? unavailable
                : `${background.protocol.lastLatencyMs.toFixed(2)} ms · ${formatByteCount(background.protocol.lastBytesRead ?? 0)}`
            }
          />
          <MetricRow label="Protocol errors" value={background?.protocol.errors ?? 0} />
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

        <Section icon={<Sparkles size={13} />} title="Decision log" definitionList={false}>
          <ol
            ref={decisionLogRef}
            role="log"
            aria-label="Adaptive media decisions"
            className="h-44 overflow-y-auto rounded-md border border-border bg-panel-muted p-2 text-[10px] leading-4 tabular-nums"
          >
            {derived?.decisionLog.length ? (
              derived.decisionLog.slice(-100).map((event) => (
                <li key={`${event.at}-${event.kind}`} className="flex items-start gap-2">
                  <time dateTime={event.at} className="shrink-0 tabular-nums text-disabled">
                    {formatLogTime(event.at)}
                  </time>
                  <p className="min-w-0 break-words text-secondary">
                    <span className="text-muted">[{event.kind}]</span> {event.detail}
                  </p>
                </li>
              ))
            ) : (
              <li className="text-muted">Waiting for adaptive media decisions…</li>
            )}
          </ol>
        </Section>
      </div>
    </aside>
  );
}

function formatBytes(value: number | undefined): React.ReactNode {
  if (value === undefined) return unavailable;
  return formatByteCount(value);
}

function formatByteCount(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value.toFixed(1)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

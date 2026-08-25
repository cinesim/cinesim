import { Activity, Cpu, Gauge, Image, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DefinitionRow,
  PaneHeader,
  SectionHeading,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@cinesim/ui";
import { formatByteCount, formatDiagnosticDurationMs, formatTimecode } from "../../lib/format";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { LiveMetricChart, type LiveMetricValues, useLiveMetricHistory } from "./live-metric-chart";
import { StorageUsage } from "./storage-usage";

type MetricsTab = "overview" | "playback" | "media" | "system";

const METRICS_TABS: ReadonlyArray<{ id: MetricsTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "playback", label: "Playback" },
  { id: "media", label: "Media" },
  { id: "system", label: "System" },
];

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <DefinitionRow label={label} value={value} />;
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
      <SectionHeading className="mb-2" icon={icon}>
        {title}
      </SectionHeading>
      {definitionList ? <dl>{children}</dl> : children}
    </section>
  );
}

const unavailable = <span className="text-disabled">Unavailable</span>;

export function MetricsSidebar() {
  const [activeTab, setActiveTab] = useState<MetricsTab>("overview");
  const metrics = useRendererStore((state) => state.playbackRuntime?.snapshot ?? null);
  const derived = useRendererStore((state) => state.derivedMedia);
  const project = useRendererStore((state) => sessionFromLifecycle(state.project)?.project ?? null);
  const projectAssets = project?.assets ?? [];
  const electronHealth = useRendererStore((state) => state.electronHealth);
  const artifacts = derived ? Object.values(derived.assets) : [];
  const background = derived?.runtime;
  const activeJob = background?.activeJob;
  const activeDerived = metrics?.activeAssetId ? derived?.assets[metrics.activeAssetId] : undefined;
  const decisionLogRef = useRef<HTMLOListElement>(null);
  const latestDecisionAt = derived?.decisionLog.at(-1)?.at;
  const artifactCount = (kind: "thumbnail" | "filmstrip" | "waveform" | "proxy") => {
    const eligibleIds = new Set<string>(
      projectAssets
        .filter((asset) =>
          kind === "waveform"
            ? asset.kind === "audio" || asset.hasAudio === true
            : asset.kind === "video",
        )
        .map((asset) => asset.id),
    );
    const eligible = artifacts.filter((asset) => eligibleIds.has(asset.assetId));
    return `${eligible.filter((asset) => asset[kind].state === "ready").length}/${eligible.length}`;
  };
  const liveSample = useMemo<LiveMetricValues | null>(() => {
    if (!metrics && !background && !electronHealth) return null;
    const healthProcesses = electronHealth?.processes;
    return {
      renderFps: metrics?.renderFps ?? 0,
      targetFps: metrics?.targetFps ?? 0,
      seekLatencyMs: metrics?.seekLatencyMs ?? 0,
      gpuSubmitCpuMs: metrics?.gpuSubmitCpuMs ?? 0,
      protocolLatencyMs: background?.protocol.lastLatencyMs ?? 0,
      mainCpuPercent: healthProcesses?.main.cpuPercent ?? 0,
      rendererCpuPercent: healthProcesses?.renderer.cpuPercent ?? 0,
      gpuCpuPercent: healthProcesses?.gpu.cpuPercent ?? 0,
      utilityCpuPercent: healthProcesses?.utility.cpuPercent ?? 0,
      mainMemoryMb: (healthProcesses?.main.memoryBytes ?? 0) / 1024 ** 2,
      rendererMemoryMb: (healthProcesses?.renderer.memoryBytes ?? 0) / 1024 ** 2,
      gpuMemoryMb: (healthProcesses?.gpu.memoryBytes ?? 0) / 1024 ** 2,
      utilityMemoryMb: (healthProcesses?.utility.memoryBytes ?? 0) / 1024 ** 2,
      mainEventLoopLagMs: electronHealth?.mainEventLoopLagMs ?? 0,
      rendererEventLoopLagMs: electronHealth?.rendererEventLoopLagMs ?? 0,
      eventLoopBudgetMs: 16.7,
    };
  }, [background, electronHealth, metrics]);
  const liveHistory = useLiveMetricHistory(liveSample);

  useEffect(() => {
    const log = decisionLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [activeTab, latestDecisionAt]);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-panel" aria-label="Metrics">
      <PaneHeader>
        <Activity size={15} className="mr-2 text-muted" />
        <h2 className="text-ui font-medium text-primary">Metrics</h2>
        <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          Local
        </span>
      </PaneHeader>
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as MetricsTab)}
        className="min-h-0 flex-1"
      >
        <TabsList className="grid shrink-0 grid-cols-4 px-2" aria-label="Metric categories">
          {METRICS_TABS.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              className="h-auto px-1 py-2 text-ui-xs data-active:after:inset-x-1 data-active:after:h-0.5"
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={activeTab} className="min-h-0 flex-1 overflow-y-auto">
          {activeTab === "overview" && (
            <>
              <Section icon={<Gauge size={13} />} title="Current state">
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
                <MetricRow
                  label="Background job"
                  value={derived?.jobs.running ? "Running" : "None"}
                />
              </Section>
              <Section icon={<Image size={13} />} title="At a glance">
                <MetricRow
                  label="App CPU"
                  value={
                    electronHealth ? `${electronHealth.totalCpuPercent.toFixed(1)}%` : unavailable
                  }
                />
                <MetricRow
                  label="App memory"
                  value={
                    electronHealth ? formatByteCount(electronHealth.totalMemoryBytes) : unavailable
                  }
                />
                <MetricRow
                  label="UI delay"
                  value={
                    electronHealth?.rendererEventLoopLagMs === null || !electronHealth
                      ? unavailable
                      : `${electronHealth.rendererEventLoopLagMs.toFixed(1)} ms`
                  }
                />
                <MetricRow label="Thumbnails" value={artifactCount("thumbnail")} />
                <MetricRow label="Filmstrips" value={artifactCount("filmstrip")} />
                <MetricRow label="Waveforms" value={artifactCount("waveform")} />
                <MetricRow label="Proxies" value={artifactCount("proxy")} />
                <MetricRow label="Dropped frames" value={metrics?.droppedFrames ?? 0} />
                <MetricRow label="Protocol errors" value={background?.protocol.errors ?? 0} />
                <MetricRow label="Derived bytes" value={formatBytes(derived?.storage.totalBytes)} />
              </Section>
            </>
          )}

          {activeTab === "playback" && (
            <>
              <ChartSection>
                <LiveMetricChart
                  title="Frame rate"
                  description="Frames presented per second compared with the project target."
                  unit="fps"
                  minimumMaximum={60}
                  samples={liveHistory}
                  series={[
                    { key: "renderFps", label: "Render", color: "var(--metric-blue)" },
                    {
                      key: "targetFps",
                      label: "Target",
                      color: "var(--metric-amber)",
                      dashed: true,
                    },
                  ]}
                />
                <LiveMetricChart
                  title="Seek response"
                  description="Time from a requested frame to presentation. Lower is better."
                  unit="ms"
                  minimumMaximum={150}
                  samples={liveHistory}
                  series={[{ key: "seekLatencyMs", label: "Latency", color: "var(--ui-text)" }]}
                />
              </ChartSection>
              <Section icon={<Activity size={13} />} title="Request totals">
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
                <MetricRow
                  label="Newest pending"
                  value={metrics?.newestRequestPending ? "Yes" : "No"}
                />
                <MetricRow label="Active sources" value={metrics?.activeSources ?? 0} />
                <MetricRow
                  label="Takeover suppressed"
                  value={metrics?.sourcePreviewSuppressions ?? 0}
                />
              </Section>
            </>
          )}

          {activeTab === "media" && (
            <>
              <ChartSection>
                <LiveMetricChart
                  title="Media read latency"
                  description="Time to serve recent original or proxy byte-range requests. Lower is better."
                  unit="ms"
                  minimumMaximum={50}
                  samples={liveHistory}
                  series={[
                    {
                      key: "protocolLatencyMs",
                      label: "Last read",
                      color: "var(--ui-text)",
                    },
                  ]}
                />
              </ChartSection>
              <Section icon={<Activity size={13} />} title="Background job">
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
                  value={activeJob ? formatDiagnosticDurationMs(activeJob.elapsedMs) : unavailable}
                />
                <MetricRow label="Last result" value={background?.lastJob?.stage ?? unavailable} />
                <MetricRow
                  label="Last duration"
                  value={
                    background?.lastJob
                      ? formatDiagnosticDurationMs(background.lastJob.durationMs)
                      : unavailable
                  }
                />
              </Section>
              <Section icon={<Activity size={13} />} title="Protocol totals">
                <MetricRow label="Requests" value={background?.protocol.requests ?? 0} />
                <MetricRow label="Range requests" value={background?.protocol.rangeRequests ?? 0} />
                <MetricRow label="Bytes read" value={formatBytes(background?.protocol.bytesRead)} />
                <MetricRow
                  label="Average latency"
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
                <MetricRow label="Errors" value={background?.protocol.errors ?? 0} />
              </Section>
              <Section icon={<Image size={13} />} title="Derived artifacts">
                <MetricRow label="Thumbnails" value={artifactCount("thumbnail")} />
                <MetricRow label="Filmstrips" value={artifactCount("filmstrip")} />
                <MetricRow label="Waveforms" value={artifactCount("waveform")} />
                <MetricRow label="Proxies" value={artifactCount("proxy")} />
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
            </>
          )}

          {activeTab === "system" && (
            <>
              <Section icon={<Activity size={13} />} title="App performance">
                <MetricRow
                  label="Total CPU"
                  value={
                    electronHealth ? `${electronHealth.totalCpuPercent.toFixed(1)}%` : unavailable
                  }
                />
                <MetricRow
                  label="Working-set memory"
                  value={
                    electronHealth ? formatByteCount(electronHealth.totalMemoryBytes) : unavailable
                  }
                />
                <MetricRow label="Processes" value={electronHealth?.processCount ?? unavailable} />
                <MetricRow
                  label="Renderer loop p95"
                  value={
                    electronHealth?.rendererEventLoopLagMs === null || !electronHealth
                      ? unavailable
                      : `${electronHealth.rendererEventLoopLagMs.toFixed(1)} ms`
                  }
                />
                <MetricRow
                  label="Main loop p95"
                  value={
                    electronHealth
                      ? `${electronHealth.mainEventLoopLagMs.toFixed(1)} ms`
                      : unavailable
                  }
                />
              </Section>
              <ChartSection>
                <LiveMetricChart
                  title="Event-loop delay"
                  description="Scheduling delay in Electron main and renderer. Lower is better."
                  unit="ms"
                  minimumMaximum={50}
                  samples={liveHistory}
                  series={[
                    {
                      key: "rendererEventLoopLagMs",
                      label: "Renderer",
                      color: "var(--metric-blue)",
                    },
                    {
                      key: "mainEventLoopLagMs",
                      label: "Main",
                      color: "var(--metric-amber)",
                    },
                    {
                      key: "eventLoopBudgetMs",
                      label: "Frame budget",
                      color: "var(--ui-text-muted)",
                      dashed: true,
                    },
                  ]}
                />
                <LiveMetricChart
                  title="CPU by process"
                  description="Combined Electron process CPU; totals may exceed 100% on multicore systems."
                  unit="%"
                  minimumMaximum={100}
                  samples={liveHistory}
                  series={[
                    { key: "rendererCpuPercent", label: "Renderer", color: "var(--metric-blue)" },
                    { key: "mainCpuPercent", label: "Main", color: "var(--metric-amber)" },
                    { key: "gpuCpuPercent", label: "GPU", color: "var(--metric-violet)" },
                    { key: "utilityCpuPercent", label: "Utility", color: "var(--metric-green)" },
                  ]}
                />
                <LiveMetricChart
                  title="Memory by process"
                  description="Physical working-set memory held by each Electron process group."
                  unit="MB"
                  minimumMaximum={512}
                  samples={liveHistory}
                  series={[
                    {
                      key: "rendererMemoryMb",
                      label: "Renderer",
                      color: "var(--metric-blue)",
                    },
                    { key: "mainMemoryMb", label: "Main", color: "var(--metric-amber)" },
                    { key: "gpuMemoryMb", label: "GPU", color: "var(--metric-violet)" },
                    {
                      key: "utilityMemoryMb",
                      label: "Utility",
                      color: "var(--metric-green)",
                    },
                  ]}
                />
                <LiveMetricChart
                  title="GPU submission"
                  description="CPU time spent submitting composed frames to WebGPU. Lower is better."
                  unit="ms"
                  minimumMaximum={16.7}
                  samples={liveHistory}
                  series={[
                    {
                      key: "gpuSubmitCpuMs",
                      label: "CPU submit",
                      color: "var(--ui-text)",
                    },
                  ]}
                />
              </ChartSection>
              <Section icon={<Cpu size={13} />} title="GPU">
                <MetricRow
                  label="CPU submit"
                  value={`${(metrics?.gpuSubmitCpuMs ?? 0).toFixed(2)} ms`}
                />
                <MetricRow label="Submitted frames" value={metrics?.gpuSubmittedFrames ?? 0} />
                <MetricRow label="Device loss" value={metrics?.gpuDeviceLostCount ?? 0} />
                <MetricRow
                  label="Output"
                  value={metrics ? `${metrics.previewWidth}×${metrics.previewHeight}` : unavailable}
                />
                <MetricRow label="GPU execution" value={unavailable} />
              </Section>
              <StorageUsage storage={derived?.storage} />
            </>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function ChartSection({ children }: { children: React.ReactNode }) {
  return <section className="space-y-3 border-b border-border p-3">{children}</section>;
}

function formatBytes(value: number | undefined): React.ReactNode {
  if (value === undefined) return unavailable;
  return formatByteCount(value);
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

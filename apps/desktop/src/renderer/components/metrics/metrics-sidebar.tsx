import { Activity, Cpu, Gauge, Image, Sparkles } from "@cinesim/ui";
import { timeUs } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import type { RuntimeSnapshot } from "@cinesim/engine";
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
import type {
  DerivedAssetSnapshot,
  DerivedRuntimeSnapshot,
  ElectronHealthSnapshot,
} from "../../../shared/contracts";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import {
  LiveMetricChart,
  type LiveMetricRateKey,
  type LiveMetricValues,
  useLiveMetricHistory,
} from "./live-metric-chart";
import { StorageUsage } from "./storage-usage";

type MetricsTab = "overview" | "playback" | "media" | "system";
const PLAYBACK_RATE_KEYS: LiveMetricRateKey[] = [
  "droppedFramesPerSecond",
  "requestsPerSecond",
  "framesPresentedPerSecond",
  "requestsCoalescedPerSecond",
];

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
  const artifactCount = (kind: DerivedArtifactKind) =>
    countArtifacts(kind, projectAssets, artifacts);
  const liveSample = useMemo(
    () => createLiveMetricSample(metrics, background, electronHealth),
    [background, electronHealth, metrics],
  );
  const liveHistory = useLiveMetricHistory(liveSample, PLAYBACK_RATE_KEYS);

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

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto">
          <Section icon={<Gauge size={13} />} title="Current state">
            <MetricRow label="Preview mode" value={metrics?.mode.kind ?? unavailable} />
            <MetricRow
              label="Transport"
              value={binaryLabel(metrics?.playing, "Playing", "Paused")}
            />
            <MetricRow label="Timeline" value={formatTimecode(metrics?.timeUs ?? timeUs(0))} />
            <MetricRow label="Foreground" value={metrics?.foregroundPressure ?? "Idle"} />
            <MetricRow label="Active asset" value={metrics?.activeAssetId ?? "None"} />
            <MetricRow label="Source" value={metrics?.activeSourceKind ?? unavailable} />
            <MetricRow
              label="Background job"
              value={binaryLabel(Boolean(derived?.jobs.running), "Running", "None")}
            />
          </Section>
          <Section icon={<Image size={13} />} title="At a glance">
            <MetricRow
              label="App CPU"
              value={formatOptional(
                electronHealth?.totalCpuPercent,
                (value) => `${value.toFixed(1)}%`,
              )}
            />
            <MetricRow
              label="App memory"
              value={formatOptional(electronHealth?.totalMemoryBytes, formatByteCount)}
            />
            <MetricRow
              label="UI delay"
              value={formatMilliseconds(electronHealth?.rendererEventLoopLagMs)}
            />
            <MetricRow label="Thumbnails" value={artifactCount("thumbnail")} />
            <MetricRow label="Filmstrips" value={artifactCount("filmstrip")} />
            <MetricRow label="Waveforms" value={artifactCount("waveform")} />
            <MetricRow label="Proxies" value={artifactCount("proxy")} />
            <MetricRow label="Dropped frames" value={metrics?.droppedFrames ?? 0} />
            <MetricRow label="Protocol errors" value={background?.protocol.errors ?? 0} />
            <MetricRow label="Derived bytes" value={formatBytes(derived?.storage.totalBytes)} />
          </Section>
        </TabsContent>

        <TabsContent value="playback" className="min-h-0 flex-1 overflow-y-auto">
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
            <LiveMetricChart
              title="Playback activity"
              description="Dropped frames, requests, presented frames, and coalesced requests per second."
              unit="/s"
              minimumMaximum={60}
              samples={liveHistory}
              series={[
                {
                  key: "droppedFramesPerSecond",
                  label: "Dropped frames",
                  color: "var(--metric-amber)",
                },
                {
                  key: "requestsPerSecond",
                  label: "Requests",
                  color: "var(--metric-blue)",
                },
                {
                  key: "framesPresentedPerSecond",
                  label: "Presented",
                  color: "var(--metric-green)",
                },
                {
                  key: "requestsCoalescedPerSecond",
                  label: "Coalesced",
                  color: "var(--metric-violet)",
                },
              ]}
            />
          </ChartSection>
          <section className="border-b border-border px-3 py-3">
            <dl>
              <MetricRow
                label="Original seek p95"
                value={formatMilliseconds(activeDerived?.performance.original.warmSeekP95Ms)}
              />
              <MetricRow
                label="Proxy seek p95"
                value={formatMilliseconds(activeDerived?.performance.proxy?.warmSeekP95Ms)}
              />
              <MetricRow label="Dropped frames" value={metrics?.droppedFrames ?? 0} />
              <MetricRow label="Requests" value={metrics?.requestsReceived ?? 0} />
              <MetricRow label="Coalesced" value={metrics?.requestsCoalesced ?? 0} />
              <MetricRow label="Presented" value={metrics?.framesPresented ?? 0} />
              <MetricRow label="Obsolete" value={metrics?.framesObsolete ?? 0} />
              <MetricRow label="In flight" value={metrics?.frameOperationsInFlight ?? 0} />
              <MetricRow
                label="Newest pending"
                value={binaryLabel(metrics?.newestRequestPending, "Yes", "No")}
              />
              <MetricRow label="Active sources" value={metrics?.activeSources ?? 0} />
              <MetricRow
                label="Takeover suppressed"
                value={metrics?.sourcePreviewSuppressions ?? 0}
              />
            </dl>
          </section>
        </TabsContent>

        <TabsContent value="media" className="min-h-0 flex-1 overflow-y-auto">
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
              value={formatOptional(activeJob?.progress, (value) => `${Math.round(value * 100)}%`)}
            />
            <MetricRow
              label="Samples"
              value={formatOptional(
                activeJob?.totalSamples,
                (value) => `${activeJob?.completedSamples ?? 0}/${value}`,
              )}
            />
            <MetricRow
              label="Worker elapsed"
              value={formatOptional(activeJob?.elapsedMs, formatDiagnosticDurationMs)}
            />
            <MetricRow label="Last result" value={background?.lastJob?.stage ?? unavailable} />
            <MetricRow
              label="Last duration"
              value={formatOptional(background?.lastJob?.durationMs, formatDiagnosticDurationMs)}
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
              value={formatOptional(
                background?.protocol.lastLatencyMs,
                (value) =>
                  `${value.toFixed(2)} ms · ${formatByteCount(background?.protocol.lastBytesRead ?? 0)}`,
              )}
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
              value={formatOptional(
                derived,
                (value) => `${value.jobs.running} running · ${value.jobs.queued} queued`,
              )}
            />
            <MetricRow label="Failed" value={derived?.jobs.failed ?? 0} />
          </Section>
          <Section icon={<Sparkles size={13} />} title="Derived media log" definitionList={false}>
            <ol
              ref={decisionLogRef}
              role="log"
              aria-label="Derived media activity"
              className="h-44 overflow-y-auto rounded-md border border-border bg-panel-muted p-2 text-[10px] leading-4 tabular-nums"
            >
              <DecisionLogItems events={derived?.decisionLog ?? []} />
            </ol>
          </Section>
        </TabsContent>

        <TabsContent value="system" className="min-h-0 flex-1 overflow-y-auto">
          <Section icon={<Activity size={13} />} title="App performance">
            <MetricRow
              label="Total CPU"
              value={formatOptional(
                electronHealth?.totalCpuPercent,
                (value) => `${value.toFixed(1)}%`,
              )}
            />
            <MetricRow
              label="Working-set memory"
              value={formatOptional(electronHealth?.totalMemoryBytes, formatByteCount)}
            />
            <MetricRow label="Processes" value={electronHealth?.processCount ?? unavailable} />
            <MetricRow
              label="Renderer loop p95"
              value={formatMilliseconds(electronHealth?.rendererEventLoopLagMs)}
            />
            <MetricRow
              label="Main loop p95"
              value={formatMilliseconds(electronHealth?.mainEventLoopLagMs)}
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
              description="Total physical working-set memory, split by Electron process group."
              unit="MB"
              minimumMaximum={512}
              samples={liveHistory}
              stacked
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
              value={formatOptional(
                metrics,
                (value) => `${value.previewWidth}×${value.previewHeight}`,
              )}
            />
            <MetricRow label="GPU execution" value={unavailable} />
          </Section>
          <StorageUsage storage={derived?.storage} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

type DerivedArtifactKind = "thumbnail" | "filmstrip" | "waveform" | "proxy";

function countArtifacts(
  kind: DerivedArtifactKind,
  projectAssets: readonly Asset[],
  artifacts: readonly DerivedAssetSnapshot[],
): string {
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
  const ready = eligible.filter((asset) => asset[kind].state === "ready");
  return `${ready.length}/${eligible.length}`;
}

function createLiveMetricSample(
  metrics: RuntimeSnapshot | null,
  background: DerivedRuntimeSnapshot | undefined,
  electronHealth: ElectronHealthSnapshot | null,
): LiveMetricValues | null {
  if (!metrics && !background && !electronHealth) return null;
  const healthProcesses = electronHealth?.processes;
  return {
    renderFps: metrics?.renderFps ?? 0,
    targetFps: metrics?.targetFps ?? 0,
    seekLatencyMs: metrics?.seekLatencyMs ?? 0,
    droppedFrames: metrics?.droppedFrames ?? 0,
    requestsReceived: metrics?.requestsReceived ?? 0,
    framesPresented: metrics?.framesPresented ?? 0,
    requestsCoalesced: metrics?.requestsCoalesced ?? 0,
    droppedFramesPerSecond: 0,
    requestsPerSecond: 0,
    framesPresentedPerSecond: 0,
    requestsCoalescedPerSecond: 0,
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
}

function binaryLabel(value: boolean | undefined, whenTrue: string, whenFalse: string): string {
  return value ? whenTrue : whenFalse;
}

function formatOptional<T>(
  value: T | null | undefined,
  format: (present: T) => React.ReactNode,
): React.ReactNode {
  return value === null || value === undefined ? unavailable : format(value);
}

function formatMilliseconds(value: number | null | undefined): React.ReactNode {
  return formatOptional(value, (present) => `${present.toFixed(1)} ms`);
}

function DecisionLogItems({
  events,
}: {
  events: ReadonlyArray<{ at: string; kind: string; detail: string }>;
}) {
  if (events.length === 0)
    return <li className="text-muted">Waiting for derived media activity…</li>;
  return events.slice(-100).map((event) => (
    <li key={`${event.at}-${event.kind}`} className="flex items-start gap-2">
      <time dateTime={event.at} className="shrink-0 tabular-nums text-disabled">
        {formatLogTime(event.at)}
      </time>
      <p className="min-w-0 break-words text-secondary">
        <span className="text-muted">[{event.kind}]</span> {event.detail}
      </p>
    </li>
  ));
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

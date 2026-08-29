import { useEffect, useRef, useState } from "react";

export interface LiveMetricValues {
  renderFps: number;
  targetFps: number;
  seekLatencyMs: number;
  droppedFrames: number;
  requestsReceived: number;
  framesPresented: number;
  requestsCoalesced: number;
  droppedFramesPerSecond: number;
  requestsPerSecond: number;
  framesPresentedPerSecond: number;
  requestsCoalescedPerSecond: number;
  gpuSubmitCpuMs: number;
  protocolLatencyMs: number;
  mainCpuPercent: number;
  rendererCpuPercent: number;
  gpuCpuPercent: number;
  utilityCpuPercent: number;
  mainMemoryMb: number;
  rendererMemoryMb: number;
  gpuMemoryMb: number;
  utilityMemoryMb: number;
  mainEventLoopLagMs: number;
  rendererEventLoopLagMs: number;
  eventLoopBudgetMs: number;
}

interface LiveMetricSample extends LiveMetricValues {
  sampledAt: number;
}

export type LiveMetricRateKey =
  | "droppedFramesPerSecond"
  | "requestsPerSecond"
  | "framesPresentedPerSecond"
  | "requestsCoalescedPerSecond";

const RATE_SOURCES: Record<LiveMetricRateKey, keyof LiveMetricValues> = {
  droppedFramesPerSecond: "droppedFrames",
  requestsPerSecond: "requestsReceived",
  framesPresentedPerSecond: "framesPresented",
  requestsCoalescedPerSecond: "requestsCoalesced",
};
const NO_RATE_KEYS: LiveMetricRateKey[] = [];

export interface LiveMetricSeries {
  key: keyof LiveMetricValues;
  label: string;
  color: string;
  dashed?: boolean;
}

export function useLiveMetricHistory(
  sample: LiveMetricValues | null,
  rateKeys: LiveMetricRateKey[] = NO_RATE_KEYS,
): LiveMetricSample[] {
  const latestSample = useRef(sample);
  const previousSample = useRef<LiveMetricSample | null>(null);
  const [history, setHistory] = useState<LiveMetricSample[]>([]);

  useEffect(() => {
    latestSample.current = sample;
  }, [sample]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const current = latestSample.current;
      if (!current) return;
      const sampledAt = Date.now();
      const elapsedSeconds = previousSample.current
        ? Math.max(0, (sampledAt - previousSample.current.sampledAt) / 1000)
        : 0;
      const nextSample = { ...current, sampledAt };

      for (const rateKey of rateKeys) {
        const sourceKey = RATE_SOURCES[rateKey];
        const currentValue = current[sourceKey];
        const previousValue = previousSample.current?.[sourceKey];
        nextSample[rateKey] =
          previousValue === undefined || elapsedSeconds <= 0
            ? 0
            : Math.max(0, (currentValue - previousValue) / elapsedSeconds);
      }

      previousSample.current = nextSample;
      setHistory((previous) => [...previous, nextSample].slice(-60));
    }, 500);
    return () => window.clearInterval(interval);
  }, [rateKeys]);

  return history;
}

export function LiveMetricChart({
  title,
  description,
  unit,
  minimumMaximum,
  samples,
  series,
  stacked = false,
}: {
  title: string;
  description: string;
  unit: string;
  minimumMaximum: number;
  samples: LiveMetricSample[];
  series: LiveMetricSeries[];
  stacked?: boolean;
}) {
  const values = stacked
    ? samples.map((sample) =>
        series.reduce((total, item) => total + Math.max(0, sample[item.key]), 0),
      )
    : samples.flatMap((sample) => series.map((item) => sample[item.key]));
  const observedMaximum = niceChartMaximum(Math.max(0, ...values));
  const maximum = observedMaximum < minimumMaximum ? minimumMaximum : observedMaximum;
  const latest = samples.at(-1);
  const latestTotal = latest
    ? series.reduce((total, item) => total + Math.max(0, latest[item.key]), 0)
    : undefined;
  const latestSampleTime = latest?.sampledAt ?? 0;
  const windowStartedAt = latestSampleTime - 30_000;
  const xAt = (index: number) =>
    Math.max(0, Math.min(100, ((samples[index]!.sampledAt - windowStartedAt) / 30_000) * 100));
  const yAt = (value: number) => 100 - (value / maximum) * 100;
  const stackBoundary = (sampleIndex: number, seriesIndex: number) =>
    series
      .slice(0, seriesIndex + 1)
      .reduce((total, item) => total + Math.max(0, samples[sampleIndex]![item.key]), 0);
  const stackBase = (sampleIndex: number, seriesIndex: number) =>
    series
      .slice(0, seriesIndex)
      .reduce((total, item) => total + Math.max(0, samples[sampleIndex]![item.key]), 0);

  return (
    <figure className="rounded-md border border-border bg-panel-muted p-1.5">
      <figcaption className="px-0.5 pt-0.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ui-xs font-semibold text-primary">{title}</h3>
          <span className="text-[10px] uppercase tracking-wide text-muted">
            {stacked && latestTotal !== undefined
              ? `Total ${formatChartValue(latestTotal, unit)} · `
              : ""}
            Live · 30 sec
          </span>
        </div>
        <p className="mt-0.5 text-ui-xs text-muted">{description}</p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1" aria-label={`${title} legend`}>
          {series.map((item) => (
            <span key={item.key} className="flex items-center gap-1 text-[10px] text-secondary">
              <span
                className="inline-block h-0 w-3 border-t"
                style={{
                  borderColor: item.color,
                  borderTopStyle: item.dashed ? "dashed" : "solid",
                }}
              />
              {item.label}
              <span className="tabular-nums text-primary">
                {formatChartValue(latest?.[item.key], unit)}
              </span>
            </span>
          ))}
        </div>
      </figcaption>
      <div className="relative mt-1.5 h-44 min-w-0 overflow-hidden">
        <svg
          className="h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-label={`${title}, live history over the last 30 seconds`}
        >
          <title>{`${title}, live history over the last 30 seconds`}</title>
          {Array.from({ length: 5 }, (_, index) => {
            const position = index * 25;
            return (
              <g key={index}>
                <line
                  x1="0"
                  x2="100"
                  y1={position}
                  y2={position}
                  stroke="var(--ui-border)"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={position}
                  x2={position}
                  y1="0"
                  y2="100"
                  stroke="var(--ui-border)"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {stacked
            ? series.map((item, seriesIndex) => {
                const topPoints = samples
                  .map(
                    (_, sampleIndex) =>
                      `${xAt(sampleIndex)},${yAt(stackBoundary(sampleIndex, seriesIndex))}`,
                  )
                  .join(" ");
                const bottomPoints = samples
                  .map((_, reverseIndex) => {
                    const sampleIndex = samples.length - 1 - reverseIndex;
                    return `${xAt(sampleIndex)},${yAt(stackBase(sampleIndex, seriesIndex))}`;
                  })
                  .join(" ");
                return (
                  <g key={item.key}>
                    <polygon
                      points={`${topPoints} ${bottomPoints}`}
                      fill={item.color}
                      fillOpacity="0.62"
                    />
                    <polyline
                      points={topPoints}
                      fill="none"
                      stroke={item.color}
                      strokeWidth="1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              })
            : series.map((item) => {
                const points = samples
                  .map((sample, index) => `${xAt(index)},${yAt(sample[item.key])}`)
                  .join(" ");
                return (
                  <polyline
                    key={item.key}
                    points={points}
                    fill="none"
                    stroke={item.color}
                    strokeWidth="1.5"
                    strokeDasharray={item.dashed ? "4 3" : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
          {stacked && samples.length > 0 && (
            <polyline
              points={samples
                .map(
                  (_, sampleIndex) =>
                    `${xAt(sampleIndex)},${yAt(stackBoundary(sampleIndex, series.length - 1))}`,
                )
                .join(" ")}
              fill="none"
              stroke="var(--ui-text)"
              strokeOpacity="0.8"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 text-[9px] tabular-nums text-disabled"
        >
          <span className="absolute left-1 top-0.5">
            {formatAxisValue(maximum)} {unit}
          </span>
          <span className="absolute bottom-3.5 left-1">0</span>
          <span className="absolute bottom-0.5 left-1">−30s</span>
          <span className="absolute bottom-0.5 right-1">now</span>
        </div>
        {samples.length === 0 && (
          <span className="absolute inset-0 grid place-items-center text-ui-xs text-muted">
            Waiting for samples
          </span>
        )}
      </div>
    </figure>
  );
}

function niceChartMaximum(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const roughStep = (value * 1.1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude * 4;
}

function formatAxisValue(value: number): string {
  if (value >= 100) return Math.round(value).toString();
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1);
}

function formatChartValue(value: number | undefined, unit: string): string {
  if (value === undefined) return "—";
  const formatted =
    value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${unit}`;
}

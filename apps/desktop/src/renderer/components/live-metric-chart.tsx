import { useEffect, useRef, useState } from "react";

export interface LiveMetricValues {
  renderFps: number;
  targetFps: number;
  seekLatencyMs: number;
  gpuSubmitCpuMs: number;
  protocolLatencyMs: number;
}

interface LiveMetricSample extends LiveMetricValues {
  sampledAt: number;
}

export interface LiveMetricSeries {
  key: keyof LiveMetricValues;
  label: string;
  color: string;
  dashed?: boolean;
}

export function useLiveMetricHistory(sample: LiveMetricValues | null): LiveMetricSample[] {
  const latestSample = useRef(sample);
  const [history, setHistory] = useState<LiveMetricSample[]>([]);

  useEffect(() => {
    latestSample.current = sample;
  }, [sample]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const current = latestSample.current;
      if (!current) return;
      setHistory((previous) => [...previous, { ...current, sampledAt: Date.now() }].slice(-60));
    }, 500);
    return () => window.clearInterval(interval);
  }, []);

  return history;
}

export function LiveMetricChart({
  title,
  description,
  unit,
  minimumMaximum,
  samples,
  series,
}: {
  title: string;
  description: string;
  unit: string;
  minimumMaximum: number;
  samples: LiveMetricSample[];
  series: LiveMetricSeries[];
}) {
  const values = samples.flatMap((sample) => series.map((item) => sample[item.key]));
  const observedMaximum = niceChartMaximum(Math.max(0, ...values));
  const maximum = observedMaximum < minimumMaximum ? minimumMaximum : observedMaximum;
  const latest = samples.at(-1);
  const latestSampleTime = latest?.sampledAt ?? Date.now();
  const windowStartedAt = latestSampleTime - 30_000;
  const xAt = (index: number) =>
    Math.max(0, Math.min(100, ((samples[index]!.sampledAt - windowStartedAt) / 30_000) * 100));
  const yAt = (value: number) => 100 - (value / maximum) * 100;

  return (
    <figure className="rounded-md border border-border bg-panel-muted p-2">
      <figcaption>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ui-xs font-semibold text-primary">{title}</h3>
          <span className="text-[10px] uppercase tracking-wide text-muted">Live · 30 sec</span>
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
      <div className="mt-2 grid h-44 grid-cols-[3rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_1rem] gap-x-1">
        <div className="flex flex-col items-end justify-between pb-px text-[10px] tabular-nums text-muted">
          <span>
            {formatAxisValue(maximum)} {unit}
          </span>
          <span>0</span>
        </div>
        <div className="relative min-h-0 min-w-0">
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
            {series.map((item) => {
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
          </svg>
          {samples.length === 0 && (
            <span className="absolute inset-0 grid place-items-center text-ui-xs text-muted">
              Waiting for samples
            </span>
          )}
        </div>
        <div className="col-start-2 flex items-end justify-between text-[10px] tabular-nums text-muted">
          <span>−30s</span>
          <span>now</span>
        </div>
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

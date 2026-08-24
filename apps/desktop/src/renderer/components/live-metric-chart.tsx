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
  samples,
  series,
}: {
  title: string;
  description: string;
  unit: string;
  samples: LiveMetricSample[];
  series: LiveMetricSeries[];
}) {
  const width = 320;
  const height = 128;
  const plot = { left: 34, right: 8, top: 8, bottom: 20 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const values = samples.flatMap((sample) => series.map((item) => sample[item.key]));
  const maximum = niceChartMaximum(Math.max(0, ...values));
  const latest = samples.at(-1);
  const latestSampleTime = latest?.sampledAt ?? Date.now();
  const windowStartedAt = latestSampleTime - 30_000;
  const xAt = (index: number) =>
    plot.left +
    Math.max(0, Math.min(1, (samples[index]!.sampledAt - windowStartedAt) / 30_000)) * plotWidth;
  const yAt = (value: number) => plot.top + plotHeight - (value / maximum) * plotHeight;

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
      <svg
        className="mt-1 h-32 w-full"
        viewBox={`0 0 ${width} ${height}`}
        aria-label={`${title}, live history over the last 30 seconds`}
      >
        <title>{`${title}, live history over the last 30 seconds`}</title>
        {Array.from({ length: 5 }, (_, index) => {
          const x = plot.left + (index / 4) * plotWidth;
          const y = plot.top + (index / 4) * plotHeight;
          return (
            <g key={index}>
              <line
                x1={plot.left}
                x2={width - plot.right}
                y1={y}
                y2={y}
                stroke="var(--ui-border)"
              />
              <line
                x1={x}
                x2={x}
                y1={plot.top}
                y2={height - plot.bottom}
                stroke="var(--ui-border)"
              />
            </g>
          );
        })}
        <text
          x={plot.left - 4}
          y={plot.top + 3}
          textAnchor="end"
          fontSize="8"
          fill="var(--ui-text-muted)"
        >
          {formatAxisValue(maximum)}
        </text>
        <text
          x={plot.left - 4}
          y={height - plot.bottom + 3}
          textAnchor="end"
          fontSize="8"
          fill="var(--ui-text-muted)"
        >
          0
        </text>
        <text
          x={plot.left}
          y={height - 5}
          textAnchor="start"
          fontSize="8"
          fill="var(--ui-text-muted)"
        >
          −30s
        </text>
        <text
          x={width - plot.right}
          y={height - 5}
          textAnchor="end"
          fontSize="8"
          fill="var(--ui-text-muted)"
        >
          now
        </text>
        {series.map((item) => {
          const points = samples
            .map((sample, index) => `${xAt(index)},${yAt(sample[item.key])}`)
            .join(" ");
          const lastValue = latest?.[item.key];
          return (
            <g key={item.key}>
              <polyline
                points={points}
                fill="none"
                stroke={item.color}
                strokeWidth="1.5"
                strokeDasharray={item.dashed ? "4 3" : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              {lastValue !== undefined && (
                <circle cx={xAt(samples.length - 1)} cy={yAt(lastValue)} r="2" fill={item.color} />
              )}
            </g>
          );
        })}
        {samples.length === 0 && (
          <text
            x={plot.left + plotWidth / 2}
            y={plot.top + plotHeight / 2}
            textAnchor="middle"
            fontSize="9"
            fill="var(--ui-text-muted)"
          >
            Waiting for samples
          </text>
        )}
      </svg>
      <p className="text-right text-[10px] text-muted">Vertical scale: {unit}</p>
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

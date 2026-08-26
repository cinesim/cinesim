import { Database } from "@cinesim/ui";
import { DefinitionRow, SectionHeading } from "@cinesim/ui";
import type { DerivedMediaSnapshot } from "../../../shared/api";
import { formatByteCount } from "../../lib/format";

type StorageSnapshot = DerivedMediaSnapshot["storage"];

const STORAGE_CATEGORIES: ReadonlyArray<{
  key: "proxyBytes" | "filmstripBytes" | "waveformBytes" | "thumbnailBytes";
  label: string;
  color: string;
}> = [
  { key: "proxyBytes", label: "Proxies", color: "var(--gray-12)" },
  { key: "filmstripBytes", label: "Filmstrips", color: "var(--gray-10)" },
  { key: "waveformBytes", label: "Waveforms", color: "var(--gray-9)" },
  { key: "thumbnailBytes", label: "Thumbnails", color: "var(--gray-8)" },
];

export function StorageUsage({ storage }: { storage: StorageSnapshot | undefined }) {
  const totalBytes = storage?.totalBytes ?? 0;
  const budgetBytes = storage?.budgetBytes ?? 0;
  const scaleBytes = Math.max(totalBytes, budgetBytes, 1);
  const usedPercentage = budgetBytes > 0 ? (totalBytes / budgetBytes) * 100 : 0;
  const remainingBytes = Math.max(0, budgetBytes - totalBytes);

  return (
    <section className="border-b border-border px-3 py-3">
      <SectionHeading className="mb-2" icon={<Database size={13} />}>
        Storage
      </SectionHeading>
      <div className="rounded-lg border border-border bg-panel-muted p-3">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="text-ui font-medium text-primary">Project cache</h4>
          <p className="text-right text-ui-xs tabular-nums text-secondary">
            {formatByteCount(totalBytes)} of {formatByteCount(budgetBytes)} used
          </p>
        </div>

        <div className="mt-3 flex h-5 overflow-hidden rounded-md bg-surface" aria-hidden="true">
          {STORAGE_CATEGORIES.map((category) => {
            const bytes = storage?.[category.key] ?? 0;
            return (
              <span
                key={category.key}
                title={`${category.label}: ${formatByteCount(bytes)}`}
                style={{
                  background: category.color,
                  flexBasis: `${(bytes / scaleBytes) * 100}%`,
                  minWidth: bytes > 0 ? 2 : 0,
                }}
              />
            );
          })}
          <span
            className="min-w-0 bg-surface"
            title={`Available budget: ${formatByteCount(remainingBytes)}`}
            style={{ flexBasis: `${(remainingBytes / scaleBytes) * 100}%` }}
          />
        </div>
        <p className="sr-only">
          {formatByteCount(totalBytes)} of {formatByteCount(budgetBytes)} used
        </p>

        <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-muted">
          <span>{formatPercentage(usedPercentage)} used</span>
          <span>{formatByteCount(remainingBytes)} available</span>
        </div>

        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {STORAGE_CATEGORIES.map((category) => {
            const bytes = storage?.[category.key] ?? 0;
            return (
              <li
                key={category.key}
                className="flex items-center gap-1.5 text-ui-xs text-secondary"
              >
                <span className="size-2 rounded-full" style={{ background: category.color }} />
                <span>{category.label}</span>
                <span className="tabular-nums text-primary">{formatByteCount(bytes)}</span>
              </li>
            );
          })}
        </ul>

        <dl className="mt-3 border-t border-border pt-2">
          <StorageRow
            label="Disk safety reserve"
            value={formatByteCount(storage?.safetyReserveBytes ?? 0)}
          />
          <StorageRow label="Automatic evictions" value={storage?.evictionCount ?? 0} />
          {storage?.lastEvictionReason && (
            <StorageRow label="Last eviction" value={storage.lastEvictionReason} />
          )}
        </dl>
      </div>
    </section>
  );
}

function StorageRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <DefinitionRow label={label} value={value} />;
}

function formatPercentage(value: number): string {
  if (value === 0) return "0%";
  if (value < 0.1) return "<0.1%";
  if (value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

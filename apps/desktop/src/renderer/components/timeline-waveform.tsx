import { useEffect, useState } from "react";
import type { Asset, Clip } from "@cinesim/core";
import type { DerivedArtifactSnapshot, DerivedMediaSnapshot } from "../../shared/api";
import { decodeWaveformEnvelope, type WaveformEnvelope } from "../../shared/waveform-format";
import { derivedArtifactUrl } from "../media/media-url";

const INT16_MAX = 0x7fff;

export function waveformEnvelopePath(
  envelope: WaveformEnvelope,
  assetDurationUs: number,
  sourceStartUs: number,
  sourceEndUs: number,
  maximumColumns = 512,
): string {
  const durationUs = Math.max(1, assetDurationUs);
  const first = Math.min(
    envelope.peakCount - 1,
    Math.max(0, Math.floor((sourceStartUs / durationUs) * envelope.peakCount)),
  );
  const exclusiveLast = Math.min(
    envelope.peakCount,
    Math.max(first + 1, Math.ceil((sourceEndUs / durationUs) * envelope.peakCount)),
  );
  const sourceColumns = exclusiveLast - first;
  const columns = Math.max(1, Math.min(maximumColumns, sourceColumns));
  const upper: string[] = [];
  const lower: string[] = [];

  for (let column = 0; column < columns; column += 1) {
    const binStart = first + Math.floor((column / columns) * sourceColumns);
    const binEnd = first + Math.max(1, Math.ceil(((column + 1) / columns) * sourceColumns));
    let minimum = 0;
    let maximum = 0;
    for (let peak = binStart; peak < Math.min(binEnd, exclusiveLast); peak += 1) {
      minimum = Math.min(minimum, envelope.peaks[peak * 2] ?? 0);
      maximum = Math.max(maximum, envelope.peaks[peak * 2 + 1] ?? 0);
    }
    const x = columns === 1 ? 500 : (column / (columns - 1)) * 1_000;
    upper.push(`${x.toFixed(2)},${(50 - (maximum / INT16_MAX) * 46).toFixed(2)}`);
    lower.push(`${x.toFixed(2)},${(50 - (minimum / INT16_MAX) * 46).toFixed(2)}`);
  }

  return `M${upper.join(" L")} L${lower.reverse().join(" L")} Z`;
}

export function TimelineWaveform({
  asset,
  clip,
  artifact,
  derived,
}: {
  asset: Asset;
  clip: Clip;
  artifact: DerivedArtifactSnapshot;
  derived: DerivedMediaSnapshot;
}) {
  const [envelope, setEnvelope] = useState<WaveformEnvelope | null>(null);
  const revision = artifact.updatedAt;
  const url =
    artifact.state === "ready" && revision
      ? derivedArtifactUrl(
          "waveform",
          asset,
          derived.projectScope,
          derived.generatorVersion,
          revision,
        )
      : null;

  useEffect(() => {
    if (!url) {
      setEnvelope(null);
      return;
    }
    const abort = new AbortController();
    void fetch(url, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Waveform request failed (${response.status})`);
        return decodeWaveformEnvelope(await response.arrayBuffer());
      })
      .then(setEnvelope)
      .catch(() => {
        if (!abort.signal.aborted) setEnvelope(null);
      });
    return () => abort.abort();
  }, [url]);

  if (!envelope) return null;
  const path = waveformEnvelopePath(
    envelope,
    asset.durationUs,
    clip.sourceStartUs,
    clip.sourceEndUs,
  );
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-1 bottom-1 h-[45%] w-[calc(100%_-_0.5rem)] overflow-visible text-clip-text-muted opacity-65"
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
    >
      <line x1="0" x2="1000" y1="50" y2="50" stroke="currentColor" opacity="0.25" />
      <path d={path} fill="currentColor" />
    </svg>
  );
}

import { useState } from "react";
import { AlertTriangle, Film, Image as ImageIcon, LoaderCircle, Music2 } from "lucide-react";
import { nearestSampleIndex, pointerSourceTimeUs } from "@cinesim/engine";
import type { Asset } from "@cinesim/core";
import type { DerivedAssetSnapshot } from "../../shared/api";
import { useUiStore } from "../store/ui-store";
import { derivedArtifactUrl } from "../media/media-job-coordinator";

interface MediaSkimSurfaceProps {
  asset: Asset;
  className?: string;
  onPreviewTime?: (sourceTimeUs: number) => void;
  onPreviewEnd?: () => void;
}

function Placeholder({ asset }: { asset: Asset }) {
  if (asset.kind === "audio") return <Music2 size={18} />;
  if (asset.kind === "image") return <ImageIcon size={18} />;
  return <Film size={18} />;
}

export function thumbnailPresentation(
  record: DerivedAssetSnapshot | undefined,
): "ready" | "pending" | "failed" | "placeholder" {
  if (record?.thumbnail.state === "ready") return "ready";
  if (record?.thumbnail.state === "queued" || record?.thumbnail.state === "running")
    return "pending";
  if (record?.thumbnail.state === "failed") return "failed";
  return "placeholder";
}

export function skimPositionPercent(skimTimeUs: number | null, durationUs: number): number | null {
  if (skimTimeUs === null || durationUs <= 0) return null;
  return Math.min(100, Math.max(0, (skimTimeUs / durationUs) * 100));
}

export function MediaSkimSurface({
  asset,
  className,
  onPreviewTime,
  onPreviewEnd,
}: MediaSkimSurfaceProps) {
  const [skimTimeUs, setSkimTimeUs] = useState<number | null>(null);
  const derived = useUiStore((state) => state.derivedMedia);
  const record = derived?.assets[asset.id];
  const thumbnailState = thumbnailPresentation(record);
  const filmstrip = record?.filmstrip;
  const filmstripReady = filmstrip?.state === "ready" && filmstrip.tileTimesUs?.length;
  const tileIndex =
    skimTimeUs !== null && filmstripReady
      ? nearestSampleIndex(filmstrip.tileTimesUs!, skimTimeUs)
      : null;
  const columns = Math.max(1, filmstrip?.columns ?? 1);
  const rows = Math.max(1, filmstrip?.rows ?? 1);
  const column = tileIndex === null ? 0 : tileIndex % columns;
  const row = tileIndex === null ? 0 : Math.floor(tileIndex / columns);
  const skimPosition = skimPositionPercent(skimTimeUs, asset.durationUs);

  function move(event: React.PointerEvent<HTMLDivElement>): void {
    if (asset.kind !== "video") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const sourceTimeUs = pointerSourceTimeUs(
      event.clientX,
      bounds.left,
      bounds.width,
      asset.durationUs,
    );
    setSkimTimeUs(sourceTimeUs);
    onPreviewTime?.(sourceTimeUs);
  }

  function leave(): void {
    setSkimTimeUs(null);
    onPreviewEnd?.();
  }

  return (
    <div
      className={`relative grid h-full w-full place-items-center overflow-hidden ${className ?? ""}`}
      onPointerMove={move}
      onPointerLeave={leave}
    >
      {tileIndex !== null ? (
        <span
          className="absolute inset-0 bg-no-repeat"
          style={{
            backgroundImage: `url("${derivedArtifactUrl("filmstrip", asset, derived?.generatorVersion)}")`,
            backgroundSize: `${columns * 100}% ${rows * 100}%`,
            backgroundPosition: `${columns === 1 ? 0 : (column / (columns - 1)) * 100}% ${rows === 1 ? 0 : (row / (rows - 1)) * 100}%`,
          }}
        />
      ) : thumbnailState === "ready" ? (
        <img
          src={derivedArtifactUrl("thumbnail", asset, derived?.generatorVersion)}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : thumbnailState === "pending" ? (
        <LoaderCircle aria-label="Generating thumbnail" className="animate-spin" size={18} />
      ) : thumbnailState === "failed" ? (
        <AlertTriangle aria-label="Thumbnail generation failed" size={18} />
      ) : (
        <Placeholder asset={asset} />
      )}
      {skimPosition !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-20 w-px -translate-x-1/2 bg-white/45 shadow-[0_0_2px_rgba(0,0,0,0.6)]"
          style={{ left: `${skimPosition}%` }}
        />
      )}
    </div>
  );
}

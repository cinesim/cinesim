import { nearestSampleIndex } from "@cinesim/engine";
import { timeUs } from "@cinesim/core";
import type { Asset, Clip, TimeUs } from "@cinesim/core";
import type { DerivedAssetSnapshot, DerivedMediaSnapshot } from "../../../shared/contracts";
import { derivedArtifactUrl } from "../../lib/media-url";
import { filmstripPresentationReady, thumbnailPresentation } from "../media/media-skim-surface";

const MAX_VISIBLE_CELLS = 96;
const MIN_CELL_WIDTH = 32;

export function timelineFilmstripCellWidth(height: number, tileAspectRatio: number): number {
  if (!Number.isFinite(height) || !Number.isFinite(tileAspectRatio)) return MIN_CELL_WIDTH;
  return Math.max(MIN_CELL_WIDTH, height * tileAspectRatio);
}

export function timelineFilmstripTileIndices({
  tileTimesUs,
  sourceStartUs,
  sourceEndUs,
  width,
  height,
  tileAspectRatio,
}: {
  tileTimesUs: readonly number[];
  sourceStartUs: TimeUs;
  sourceEndUs: TimeUs;
  width: number;
  height: number;
  tileAspectRatio: number;
}): number[] {
  if (tileTimesUs.length === 0 || sourceEndUs <= sourceStartUs || width <= 0 || height <= 0)
    return [];
  const preferredCellWidth = timelineFilmstripCellWidth(height, tileAspectRatio);
  const cellCount = Math.min(MAX_VISIBLE_CELLS, Math.max(1, Math.ceil(width / preferredCellWidth)));
  const sourceDurationUs = sourceEndUs - sourceStartUs;
  return Array.from({ length: cellCount }, (_, index) => {
    const sampleTimeUs = sourceStartUs + Math.round(((index + 0.5) / cellCount) * sourceDurationUs);
    return nearestSampleIndex(tileTimesUs.map(timeUs), timeUs(sampleTimeUs));
  });
}

export function TimelineFilmstrip({
  asset,
  clip,
  record,
  derived,
  width,
  height,
}: {
  asset: Asset;
  clip: Pick<Clip, "sourceStartUs" | "sourceEndUs">;
  record: DerivedAssetSnapshot;
  derived: DerivedMediaSnapshot;
  width: number;
  height: number;
}) {
  const filmstrip = record.filmstrip;
  const ready = filmstripPresentationReady(record);
  const tileWidth = filmstrip.tileWidth ?? 1;
  const tileHeight = filmstrip.tileHeight ?? 1;
  const cellWidth = timelineFilmstripCellWidth(height, tileWidth / tileHeight);
  const tileIndices = ready
    ? timelineFilmstripTileIndices({
        tileTimesUs: filmstrip.tileTimesUs ?? [],
        sourceStartUs: clip.sourceStartUs,
        sourceEndUs: clip.sourceEndUs,
        width,
        height,
        tileAspectRatio: tileWidth / tileHeight,
      })
    : [];

  if (tileIndices.length > 0) {
    const columns = filmstrip.columns!;
    const rows = filmstrip.rows!;
    const imageUrl = derivedArtifactUrl(
      "filmstrip",
      asset,
      derived.projectScope,
      derived.generatorVersion,
      filmstrip.updatedAt!,
    );
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex overflow-hidden bg-black/15"
      >
        {tileIndices.map((tileIndex, cellIndex) => {
          const column = tileIndex % columns;
          const row = Math.floor(tileIndex / columns);
          return (
            <span
              key={`${cellIndex}:${tileIndex}`}
              className="h-full shrink-0 border-r border-black/30 bg-center bg-no-repeat opacity-95 last:border-r-0"
              style={{
                width: cellWidth,
                marginLeft:
                  tileIndices.length === 1 && width < cellWidth
                    ? (width - cellWidth) / 2
                    : undefined,
                backgroundImage: `url("${imageUrl}")`,
                backgroundSize: `${columns * 100}% ${rows * 100}%`,
                backgroundPosition: `${columns === 1 ? 0 : (column / (columns - 1)) * 100}% ${rows === 1 ? 0 : (row / (rows - 1)) * 100}%`,
              }}
            />
          );
        })}
      </div>
    );
  }

  if (thumbnailPresentation(record) !== "ready") return null;
  return (
    <img
      aria-hidden="true"
      src={derivedArtifactUrl(
        "thumbnail",
        asset,
        derived.projectScope,
        derived.generatorVersion,
        record.thumbnail.updatedAt!,
      )}
      alt=""
      draggable={false}
      className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-95"
    />
  );
}

import type { Asset } from "@cinesim/core";
import type {
  BeginDerivedWrite,
  DerivedArtifactKind,
  DerivedArtifactSnapshot,
  FinalizeDerivedWrite,
} from "../../shared/contracts";
import {
  WAVEFORM_FORMAT_VERSION,
  waveformByteLength,
  waveformPeakCount,
} from "../../shared/waveform-format";
import { isAssetId, MAX_ARTIFACT_BYTES, validProfile } from "./model";

const NONNEGATIVE_METADATA_FIELDS = [
  "sourceTimeUs",
  "columns",
  "rows",
  "tileWidth",
  "tileHeight",
  "peakCount",
  "waveformFormatVersion",
] as const satisfies readonly (keyof FinalizeDerivedWrite)[];

function validateNonnegativeMetadata(result: FinalizeDerivedWrite): void {
  for (const field of NONNEGATIVE_METADATA_FIELDS) {
    const value = result[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Invalid derived metadata");
  }
}

function validateFilmstripTimes(tileTimesUs: number[] | undefined): void {
  if (
    tileTimesUs &&
    (tileTimesUs.length > 64 ||
      tileTimesUs.some((value) => !Number.isSafeInteger(value) || value < 0))
  )
    throw new Error("Invalid filmstrip times");
}

function validateWaveformMetadata(result: FinalizeDerivedWrite, asset: Asset): void {
  const valid =
    result.waveformFormatVersion === WAVEFORM_FORMAT_VERSION &&
    result.peakCount === waveformPeakCount(asset.durationUs) &&
    result.bytes === waveformByteLength(result.peakCount);
  if (!valid) throw new Error("Incomplete or inconsistent waveform metadata");
}

function rejectWaveformMetadata(result: FinalizeDerivedWrite): void {
  if (result.peakCount !== undefined || result.waveformFormatVersion !== undefined)
    throw new Error("Waveform metadata is only valid for waveforms");
}

export function validateWriteInput(input: BeginDerivedWrite): void {
  if (!isAssetId(input.assetId)) throw new Error("Invalid asset ID");
  if (!["thumbnail", "filmstrip", "waveform", "proxy"].includes(input.kind))
    throw new Error("Invalid derived artifact kind");
  if (!validProfile(input.profileId)) throw new Error("Invalid proxy profile");
  if (input.kind !== "proxy" && input.profileId)
    throw new Error("Profiles are only valid for proxies");
  if (
    input.expectedBytes !== undefined &&
    (!Number.isSafeInteger(input.expectedBytes) ||
      input.expectedBytes <= 0 ||
      input.expectedBytes > MAX_ARTIFACT_BYTES)
  )
    throw new Error("Invalid expected derived size");
}

export function validateFinalize(
  kind: DerivedArtifactKind,
  result: FinalizeDerivedWrite,
  asset: Asset,
): void {
  validateNonnegativeMetadata(result);
  validateFilmstripTimes(result.tileTimesUs);
  if (kind === "filmstrip" && !validFilmstripMetadata(result))
    throw new Error("Incomplete or inconsistent filmstrip metadata");
  if (kind === "waveform") validateWaveformMetadata(result, asset);
  else rejectWaveformMetadata(result);
}

export function validFilmstripMetadata(
  value: Pick<
    DerivedArtifactSnapshot,
    "tileTimesUs" | "columns" | "rows" | "tileWidth" | "tileHeight"
  >,
): boolean {
  const { tileTimesUs, columns, rows, tileWidth, tileHeight } = value;
  if (!tileTimesUs?.length) return false;
  if (!Number.isSafeInteger(columns) || columns === undefined || columns <= 0) return false;
  if (!Number.isSafeInteger(rows) || rows !== Math.ceil(tileTimesUs.length / columns)) return false;
  if (!Number.isSafeInteger(tileWidth) || tileWidth === undefined || tileWidth <= 0) return false;
  return Number.isSafeInteger(tileHeight) && tileHeight !== undefined && tileHeight > 0;
}

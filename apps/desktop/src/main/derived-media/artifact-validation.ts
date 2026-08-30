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
  for (const value of [
    result.sourceTimeUs,
    result.columns,
    result.rows,
    result.tileWidth,
    result.tileHeight,
    result.peakCount,
    result.waveformFormatVersion,
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Invalid derived metadata");
  }
  if (
    result.tileTimesUs &&
    (result.tileTimesUs.length > 64 ||
      result.tileTimesUs.some((value) => !Number.isSafeInteger(value) || value < 0))
  )
    throw new Error("Invalid filmstrip times");
  if (kind === "filmstrip" && !validFilmstripMetadata(result))
    throw new Error("Incomplete or inconsistent filmstrip metadata");
  if (
    kind === "waveform" &&
    (result.waveformFormatVersion !== WAVEFORM_FORMAT_VERSION ||
      result.peakCount !== waveformPeakCount(asset.durationUs) ||
      result.bytes !== waveformByteLength(result.peakCount))
  )
    throw new Error("Incomplete or inconsistent waveform metadata");
  if (
    kind !== "waveform" &&
    (result.peakCount !== undefined || result.waveformFormatVersion !== undefined)
  )
    throw new Error("Waveform metadata is only valid for waveforms");
}

export function validFilmstripMetadata(
  value: Pick<
    DerivedArtifactSnapshot,
    "tileTimesUs" | "columns" | "rows" | "tileWidth" | "tileHeight"
  >,
): boolean {
  const { tileTimesUs, columns, rows, tileWidth, tileHeight } = value;
  return Boolean(
    tileTimesUs?.length &&
    Number.isSafeInteger(columns) &&
    columns! > 0 &&
    Number.isSafeInteger(rows) &&
    rows === Math.ceil(tileTimesUs.length / columns!) &&
    Number.isSafeInteger(tileWidth) &&
    tileWidth! > 0 &&
    Number.isSafeInteger(tileHeight) &&
    tileHeight! > 0,
  );
}

import type { Asset, AssetId } from "@cinesim/core";
import type { CloudTransferSnapshot, DerivedAssetSnapshot } from "../../../shared/contracts";
import type { TranscriptSnapshot } from "../../../shared/transcript";

export type TranscriptAction = "generate" | "regenerate" | "cancel" | null;

export function transcriptActionFor(
  assets: readonly Asset[],
  transcripts: TranscriptSnapshot | null,
): TranscriptAction {
  if (assets.length === 0) return null;
  const states = assets.map((asset) => transcripts?.assets[asset.id]?.state ?? "missing");
  if (states.some((state) => state === "queued" || state === "running")) return "cancel";
  return states.some((state) => state === "ready") ? "regenerate" : "generate";
}

export function retryableAssetId(
  asset: Asset | undefined,
  transfer: CloudTransferSnapshot | undefined,
): AssetId | null {
  if (!asset || !transfer) return null;
  return ["waiting-for-cloud", "paused", "failed"].includes(transfer.state) ? asset.id : null;
}

export function assetNeedsEditProxy(
  asset: Asset,
  derived: DerivedAssetSnapshot | undefined,
): boolean {
  if (asset.kind !== "video" && asset.kind !== "audio") return false;
  return derived?.proxy.state === "missing" || derived?.proxy.state === "failed";
}

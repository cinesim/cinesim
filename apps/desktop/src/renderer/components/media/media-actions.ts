import type { Asset } from "@cinesim/core";
import type { DerivedAssetSnapshot } from "../../../shared/api";

export function assetNeedsEditProxy(
  asset: Asset,
  derived: DerivedAssetSnapshot | undefined,
): boolean {
  if (asset.kind !== "video" && asset.kind !== "audio") return false;
  return derived?.proxy.state === "missing" || derived?.proxy.state === "failed";
}

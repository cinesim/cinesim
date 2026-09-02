import type { Asset } from "@cinesim/core";

export function assetSourceMetadataLabel(asset: Asset): string | null {
  const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : null;
  const frameRate =
    asset.kind === "video" && asset.frameRate ? `${Number(asset.frameRate.toFixed(2))} fps` : null;
  const codec = asset.technical?.video?.codec ?? asset.technical?.audio?.codec ?? null;
  const frameRateMode = asset.technical?.video?.frameRate.mode === "variable" ? "VFR" : null;
  const hdr = asset.technical?.video?.color.hdr ? "HDR" : null;
  const metadata = [dimensions, frameRate, frameRateMode, codec?.toUpperCase(), hdr].filter(
    (value): value is string => value !== null,
  );

  return metadata.length > 0 ? metadata.join(" · ") : null;
}

export function assetCompatibilityLabel(asset: Asset): string | null {
  const compatibility = asset.technical?.compatibility;
  if (compatibility === "unsupported") return "Unsupported media";
  if (compatibility === "partial") return "Partially supported";
  if (compatibility === "unknown") return "Decode support unverified";
  if (asset.technical?.video?.color.uncertain) return "Color metadata uncertain";
  return null;
}

export function AssetSourceMetadata({ asset, className }: { asset: Asset; className: string }) {
  const metadata = assetSourceMetadataLabel(asset);
  if (!metadata) return null;

  return <p className={className}>{metadata}</p>;
}

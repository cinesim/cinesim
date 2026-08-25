import type { Asset } from "@cinesim/core";

function sourceMetadata(asset: Asset): string | null {
  if (asset.kind !== "video" && asset.kind !== "image") return null;

  const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : null;
  const frameRate =
    asset.kind === "video" && asset.frameRate ? `${Number(asset.frameRate.toFixed(2))} fps` : null;
  const metadata = [dimensions, frameRate].filter((value): value is string => value !== null);

  return metadata.length > 0 ? metadata.join(" · ") : null;
}

export function AssetSourceMetadata({ asset, className }: { asset: Asset; className: string }) {
  const metadata = sourceMetadata(asset);
  if (!metadata) return null;

  return <p className={className}>{metadata}</p>;
}

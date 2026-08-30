import type { Asset } from "@cinesim/core";
import type { DerivedArtifactKind, DerivedProjectScope } from "../../shared/contracts";

export function originalMediaUrl(asset: Pick<Asset, "id">, scope: DerivedProjectScope): string {
  return `cinesim-media://asset/${scope.cacheKey}/${asset.id}?epoch=${encodeURIComponent(scope.epoch)}`;
}

export function derivedArtifactUrl(
  kind: DerivedArtifactKind,
  asset: Pick<Asset, "id">,
  scope: DerivedProjectScope,
  generatorVersion: string,
  revision: string,
  profileId?: string,
): string {
  const query = new URLSearchParams({
    epoch: scope.epoch,
    v: generatorVersion,
    revision,
  });
  if (profileId) query.set("profile", profileId);
  return `cinesim-media://${kind}/${scope.cacheKey}/${asset.id}?${query.toString()}`;
}

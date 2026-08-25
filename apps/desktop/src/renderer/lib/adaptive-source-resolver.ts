import type { AssetId } from "@cinesim/core";
import type { MediaSourceDescriptor, MediaSourceResolver } from "@cinesim/engine";
import type { DerivedMediaSnapshot } from "../../shared/api";
import type { DerivedProjectScope } from "../../shared/api";
import { derivedArtifactUrl, originalMediaUrl } from "./media-url";

export class AdaptiveSourceResolver implements MediaSourceResolver {
  constructor(
    private readonly projectScope: DerivedProjectScope,
    private readonly getDerivedMedia: () => DerivedMediaSnapshot | null,
  ) {}

  resolve(assetId: AssetId): MediaSourceDescriptor {
    const derived = this.getDerivedMedia();
    const proxy = derived?.assets[assetId]?.proxy;
    if (
      derived?.projectScope.cacheKey === this.projectScope.cacheKey &&
      derived.projectScope.epoch === this.projectScope.epoch &&
      proxy?.state === "ready" &&
      proxy.profileId &&
      proxy.updatedAt
    ) {
      return {
        assetId,
        kind: "proxy",
        url: derivedArtifactUrl(
          "proxy",
          { id: assetId },
          this.projectScope,
          derived.generatorVersion,
          proxy.updatedAt,
          proxy.profileId,
        ),
      };
    }
    return this.resolveOriginal(assetId);
  }

  resolveOriginal(assetId: AssetId): MediaSourceDescriptor {
    return {
      assetId,
      kind: "original",
      url: originalMediaUrl({ id: assetId }, this.projectScope),
    };
  }
}

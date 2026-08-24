import type { AssetId } from "@cinesim/core";
import type { MediaSourceDescriptor, MediaSourceResolver } from "@cinesim/engine";
import { useUiStore } from "../store/ui-store";

export class AdaptiveSourceResolver implements MediaSourceResolver {
  resolve(assetId: AssetId): MediaSourceDescriptor {
    const derived = useUiStore.getState().derivedMedia;
    const proxy = derived?.assets[assetId]?.proxy;
    if (proxy?.state === "ready" && proxy.profileId) {
      return {
        assetId,
        kind: "proxy",
        url: `cinesim-media://proxy/${assetId}?profile=${encodeURIComponent(proxy.profileId)}&v=${encodeURIComponent(derived?.generatorVersion ?? "1")}`,
      };
    }
    return { assetId, kind: "original", url: `cinesim-media://asset/${assetId}` };
  }
}

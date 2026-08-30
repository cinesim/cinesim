import { timeUs } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import type { Asset } from "@cinesim/core";
import type { DerivedArtifactState, DerivedAssetSnapshot } from "../src/shared/api";
import { assetNeedsEditProxy } from "../src/renderer/components/media/media-actions";

const video: Asset = {
  id: "asset_fixture",
  kind: "video",
  name: "fixture.mov",
  source: { kind: "cloud", cloudAssetId: "cloud_asset_fixture00000001" },
  durationUs: timeUs(1_000_000),
};

function derived(proxyState: DerivedArtifactState): DerivedAssetSnapshot {
  return {
    assetId: video.id,
    fingerprintStatus: "current",
    thumbnail: { state: "ready" },
    filmstrip: { state: "ready" },
    waveform: { state: "ready" },
    proxy: { state: proxyState },
    performance: {
      original: {
        observations: 0,
        requestsReceived: 0,
        requestsCoalesced: 0,
        framesPresented: 0,
        framesObsolete: 0,
      },
    },
  };
}

describe("media context actions", () => {
  it("offers proxy generation only for missing or failed edit proxies", () => {
    expect(assetNeedsEditProxy(video, derived("missing"))).toBe(true);
    expect(assetNeedsEditProxy(video, derived("failed"))).toBe(true);
    expect(assetNeedsEditProxy(video, derived("queued"))).toBe(false);
    expect(assetNeedsEditProxy(video, derived("running"))).toBe(false);
    expect(assetNeedsEditProxy(video, derived("ready"))).toBe(false);
    expect(assetNeedsEditProxy(video, undefined)).toBe(false);
  });
});

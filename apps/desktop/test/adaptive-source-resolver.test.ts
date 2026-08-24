import { afterEach, describe, expect, it } from "vitest";
import type { DerivedMediaSnapshot } from "../src/shared/api";
import { AdaptiveSourceResolver } from "../src/renderer/media/adaptive-source-resolver";
import { useUiStore } from "../src/renderer/store/ui-store";

function snapshot(proxyState: "ready" | "failed"): DerivedMediaSnapshot {
  const artifact = { state: "missing" as const };
  return {
    version: 1,
    generatorVersion: "1",
    assets: {
      asset_fixture: {
        assetId: "asset_fixture",
        fingerprintStatus: "current",
        thumbnail: artifact,
        filmstrip: artifact,
        proxy:
          proxyState === "ready"
            ? { state: "ready", profileId: "edit-1280", bytes: 100 }
            : { state: "failed", failureCode: "source-undecodable" },
        performance: {
          original: {
            observations: 5,
            requestsReceived: 5,
            requestsCoalesced: 0,
            framesPresented: 5,
            framesObsolete: 0,
          },
          decision: proxyState === "ready" ? "proxy-ready" : "proxy-failed",
          reasons: [],
        },
      },
    },
    storage: {
      totalBytes: 100,
      budgetBytes: 1_000,
      safetyReserveBytes: 100,
      thumbnailBytes: 0,
      filmstripBytes: 0,
      proxyBytes: 100,
      evictionCount: 0,
    },
    jobs: { queued: 0, running: 0, completed: 1, failed: 0 },
    runtime: {
      protocol: {
        requests: 0,
        rangeRequests: 0,
        bytesRead: 0,
        averageLatencyMs: 0,
        errors: 0,
      },
    },
    decisionLog: [],
  };
}

afterEach(() => useUiStore.getState().setDerivedMedia(null));

describe("AdaptiveSourceResolver", () => {
  it("uses a valid proxy automatically", () => {
    useUiStore.getState().setDerivedMedia(snapshot("ready"));
    expect(new AdaptiveSourceResolver().resolve("asset_fixture")).toEqual({
      assetId: "asset_fixture",
      kind: "proxy",
      url: "cinesim-media://proxy/asset_fixture?profile=edit-1280&v=1",
    });
  });

  it("falls back to the original after proxy failure", () => {
    useUiStore.getState().setDerivedMedia(snapshot("failed"));
    expect(new AdaptiveSourceResolver().resolve("asset_fixture")).toEqual({
      assetId: "asset_fixture",
      kind: "original",
      url: "cinesim-media://asset/asset_fixture",
    });
  });
});

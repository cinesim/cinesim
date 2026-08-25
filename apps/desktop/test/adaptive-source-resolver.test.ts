import { describe, expect, it } from "vitest";
import type { DerivedMediaSnapshot } from "../src/shared/api";
import { AdaptiveSourceResolver } from "../src/renderer/lib/adaptive-source-resolver";

const projectScope = {
  cacheKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
  epoch: "00000000-0000-4000-8000-000000000001",
};

function snapshot(proxyState: "ready" | "failed"): DerivedMediaSnapshot {
  const artifact = { state: "missing" as const };
  return {
    version: 1,
    generatorVersion: "3",
    projectScope,
    assets: {
      asset_fixture: {
        assetId: "asset_fixture",
        fingerprintStatus: "current",
        thumbnail: artifact,
        filmstrip: artifact,
        waveform: { state: "missing" },
        proxy:
          proxyState === "ready"
            ? {
                state: "ready",
                profileId: "edit-1280",
                bytes: 100,
                updatedAt: "proxy-revision",
              }
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
      waveformBytes: 0,
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

describe("AdaptiveSourceResolver", () => {
  it("uses a valid proxy automatically", () => {
    expect(
      new AdaptiveSourceResolver(projectScope, () => snapshot("ready")).resolve("asset_fixture"),
    ).toEqual({
      assetId: "asset_fixture",
      kind: "proxy",
      url: "cinesim-media://proxy/aaaaaaaaaaaaaaaaaaaaaaaa/asset_fixture?epoch=00000000-0000-4000-8000-000000000001&v=3&revision=proxy-revision&profile=edit-1280",
    });
  });

  it("falls back to the original after proxy failure", () => {
    expect(
      new AdaptiveSourceResolver(projectScope, () => snapshot("failed")).resolve("asset_fixture"),
    ).toEqual({
      assetId: "asset_fixture",
      kind: "original",
      url: "cinesim-media://asset/aaaaaaaaaaaaaaaaaaaaaaaa/asset_fixture?epoch=00000000-0000-4000-8000-000000000001",
    });
  });

  it("resolves the scoped original explicitly when audio cannot use the video-only proxy", () => {
    expect(
      new AdaptiveSourceResolver(projectScope, () => snapshot("ready")).resolveOriginal(
        "asset_fixture",
      ),
    ).toEqual({
      assetId: "asset_fixture",
      kind: "original",
      url: "cinesim-media://asset/aaaaaaaaaaaaaaaaaaaaaaaa/asset_fixture?epoch=00000000-0000-4000-8000-000000000001",
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Asset } from "@cinesim/core";
import type { DerivedArtifactState, DerivedMediaSnapshot } from "../src/shared/api";
import { thumbnailPresentation } from "../src/renderer/components/media-skim-surface";
import { derivedArtifactUrl } from "../src/renderer/media/media-job-coordinator";

const asset: Asset = {
  id: "asset_fixture",
  kind: "video",
  name: "fixture.mp4",
  source: { kind: "local", path: "/tmp/fixture.mp4" },
  durationUs: 2_000_000,
};

function snapshot(thumbnailState: DerivedArtifactState): DerivedMediaSnapshot {
  return {
    version: 1,
    generatorVersion: "1",
    assets: {
      asset_fixture: {
        assetId: "asset_fixture",
        fingerprintStatus: "current",
        thumbnail:
          thumbnailState === "ready"
            ? { state: "ready", bytes: 100 }
            : thumbnailState === "failed"
              ? { state: "failed", failureCode: "generation-failed" }
              : { state: thumbnailState },
        filmstrip: { state: "missing" },
        proxy: { state: "missing" },
        performance: {
          original: {
            observations: 0,
            requestsReceived: 0,
            requestsCoalesced: 0,
            framesPresented: 0,
            framesObsolete: 0,
          },
          decision: "observing",
          reasons: [],
        },
      },
    },
    storage: {
      totalBytes: 0,
      budgetBytes: 1_000,
      safetyReserveBytes: 100,
      thumbnailBytes: 0,
      filmstripBytes: 0,
      proxyBytes: 0,
      evictionCount: 0,
    },
    jobs: { queued: 0, running: 0, completed: 0, failed: 0 },
    decisionLog: [],
  };
}

function presentation(thumbnailState: DerivedArtifactState) {
  return thumbnailPresentation(snapshot(thumbnailState).assets.asset_fixture);
}

describe("MediaSkimSurface", () => {
  it("distinguishes a generating thumbnail from an unprocessed video", () => {
    expect(presentation("running")).toBe("pending");
    expect(presentation("missing")).toBe("placeholder");
  });

  it("shows a generated thumbnail without waiting for a filmstrip", () => {
    expect(presentation("ready")).toBe("ready");
    expect(derivedArtifactUrl("thumbnail", asset)).toBe(
      "cinesim-media://thumbnail/asset_fixture?v=1",
    );
  });

  it("surfaces thumbnail generation failure", () => {
    expect(presentation("failed")).toBe("failed");
  });
});

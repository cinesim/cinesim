import { timeUs } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import type { Asset } from "@cinesim/core";
import type { DerivedArtifactState, DerivedMediaSnapshot } from "../src/shared/api";
import {
  filmstripPresentationReady,
  skimPositionPercent,
  thumbnailPresentation,
} from "../src/renderer/components/media/media-skim-surface";
import { derivedArtifactUrl } from "../src/renderer/lib/media-url";

const projectScope = {
  cacheKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
  epoch: "00000000-0000-4000-8000-000000000001",
};

const asset: Asset = {
  id: "asset_fixture",
  kind: "video",
  name: "fixture.mp4",
  source: { kind: "local", path: "/tmp/fixture.mp4" },
  durationUs: timeUs(2_000_000),
};

function snapshot(thumbnailState: DerivedArtifactState): DerivedMediaSnapshot {
  return {
    version: 1,
    generatorVersion: "3",
    projectScope,
    assets: {
      asset_fixture: {
        assetId: "asset_fixture",
        fingerprintStatus: "current",
        thumbnail:
          thumbnailState === "ready"
            ? { state: "ready", bytes: 100, updatedAt: "thumbnail-revision" }
            : thumbnailState === "failed"
              ? { state: "failed", failureCode: "generation-failed" }
              : { state: thumbnailState },
        filmstrip: { state: "missing" },
        waveform: { state: "missing" },
        proxy: { state: "missing" },
        performance: {
          original: {
            observations: 0,
            requestsReceived: 0,
            requestsCoalesced: 0,
            framesPresented: 0,
            framesObsolete: 0,
          },
        },
      },
    },
    storage: {
      totalBytes: 0,
      budgetBytes: 1_000,
      safetyReserveBytes: 100,
      thumbnailBytes: 0,
      filmstripBytes: 0,
      waveformBytes: 0,
      proxyBytes: 0,
      evictionCount: 0,
    },
    jobs: { queued: 0, running: 0, completed: 0, failed: 0 },
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
    expect(derivedArtifactUrl("thumbnail", asset, projectScope, "2", "thumbnail-revision")).toBe(
      "cinesim-media://thumbnail/aaaaaaaaaaaaaaaaaaaaaaaa/asset_fixture?epoch=00000000-0000-4000-8000-000000000001&v=2&revision=thumbnail-revision",
    );
  });

  it("uses different immutable URLs for identical asset IDs in different projects", () => {
    const first = derivedArtifactUrl("filmstrip", asset, projectScope, "2", "filmstrip-revision");
    const second = derivedArtifactUrl(
      "filmstrip",
      asset,
      { ...projectScope, cacheKey: "bbbbbbbbbbbbbbbbbbbbbbbb" },
      "2",
      "filmstrip-revision",
    );
    expect(first).not.toBe(second);
  });

  it("rejects incomplete or inconsistent filmstrip tile metadata", () => {
    const record = snapshot("ready").assets.asset_fixture!;
    record.filmstrip = {
      state: "ready",
      bytes: 100,
      updatedAt: "filmstrip-revision",
      tileTimesUs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      columns: 8,
      rows: 4,
      tileWidth: 160,
      tileHeight: 90,
    };
    expect(filmstripPresentationReady(record)).toBe(false);
    record.filmstrip.rows = 2;
    expect(filmstripPresentationReady(record)).toBe(true);
  });

  it("surfaces thumbnail generation failure", () => {
    expect(presentation("failed")).toBe("failed");
  });

  it("maps the skim time to a bounded position marker", () => {
    expect(skimPositionPercent(null, asset.durationUs)).toBeNull();
    expect(skimPositionPercent(0, asset.durationUs)).toBe(0);
    expect(skimPositionPercent(1_000_000, asset.durationUs)).toBe(50);
    expect(skimPositionPercent(3_000_000, asset.durationUs)).toBe(100);
    expect(skimPositionPercent(1, 0)).toBeNull();
  });
});

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import { DerivedMediaStore } from "../src/main/derived-media/service";
import { encodeWaveformEnvelope, WAVEFORM_FORMAT_VERSION } from "../src/shared/waveform-format";

const temporaryDirectories: string[] = [];

async function fixture(name: string): Promise<{ directory: string; project: Project }> {
  const directory = await mkdtemp(join(tmpdir(), `cinesim-derived-${name}-`));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "source.mp4");
  await writeFile(sourcePath, new Uint8Array([1, 2, 3, 4, 5, 6]));
  const project = applyCommand(createProject({ name }), {
    type: "asset.import",
    asset: {
      id: "asset_fixture",
      kind: "video",
      name: "source.mp4",
      source: { kind: "local", path: sourcePath },
      durationUs: 1_000_000,
      width: 1280,
      height: 720,
      hasAudio: true,
    },
  }).project;
  return { directory, project };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("DerivedMediaStore", () => {
  it("atomically publishes bounded artifacts without exposing paths", async () => {
    const { directory, project } = await fixture("write");
    const store = new DerivedMediaStore();
    await store.setProject(directory, project);
    const scope = store.scope();
    await store.requestJobs(scope, ["asset_fixture"]);

    const { writerId } = await store.beginWrite(scope, {
      assetId: "asset_fixture",
      kind: "thumbnail",
      expectedBytes: 4,
    });
    await store.writeChunk(writerId, 0, new Uint8Array([10, 20]));
    await store.writeChunk(writerId, 2, new Uint8Array([30, 40]));
    await store.finalizeWrite(writerId, { bytes: 4, sourceTimeUs: 250_000 });

    const snapshot = store.snapshot();
    expect(snapshot.assets.asset_fixture?.thumbnail).toMatchObject({
      state: "ready",
      bytes: 4,
      sourceTimeUs: 250_000,
    });
    expect(JSON.stringify(snapshot)).not.toContain(directory);
    expect(JSON.stringify(snapshot)).not.toContain("relativePath");
    const indexPath = join(directory, ".video", "cache", "media-intelligence.json");
    const indexBeforeRead = await stat(indexPath);
    const artifactFile = await store.artifactFile(
      scope,
      "thumbnail",
      "asset_fixture",
      undefined,
      snapshot.assets.asset_fixture!.thumbnail.updatedAt,
    );
    expect(artifactFile).toMatchObject({ size: 4, mimeType: "image/jpeg" });
    expect(artifactFile.path.startsWith(join(directory, ".video"))).toBe(true);
    expect([...(await readFile(artifactFile.path))]).toEqual([10, 20, 30, 40]);
    await expect(
      store.artifactFile(scope, "thumbnail", "asset_fixture", undefined, "stale-revision"),
    ).rejects.toThrow("Unknown derived artifact revision");
    expect((await stat(indexPath)).ino).toBe(indexBeforeRead.ino);
  });

  it("validates writer bounds, ownership, and final sizes", async () => {
    const { directory, project } = await fixture("bounds");
    const store = new DerivedMediaStore();
    await store.setProject(directory, project);
    const scope = store.scope();

    await expect(
      store.beginWrite(scope, {
        assetId: "asset_fixture",
        kind: "proxy",
        profileId: "../bad",
      }),
    ).rejects.toThrow("Invalid proxy profile");
    const { writerId } = await store.beginWrite(scope, {
      assetId: "asset_fixture",
      kind: "filmstrip",
      expectedBytes: 2,
    });
    await expect(store.writeChunk(writerId, 0, new Uint8Array(3))).rejects.toThrow(
      "exceeds its bound",
    );
    await store.writeChunk(writerId, 0, new Uint8Array([1, 2]));
    await expect(store.finalizeWrite(writerId, { bytes: 1 })).rejects.toThrow(
      "does not match written data",
    );
    await store.cancelWrite(writerId);
    expect(store.snapshot().assets.asset_fixture?.filmstrip.state).toBe("queued");
    await expect(store.writeChunk(writerId, 0, new Uint8Array([1]))).rejects.toThrow(
      "Unknown derived writer",
    );
  });

  it("requires complete filmstrip grid metadata before publishing", async () => {
    const { directory, project } = await fixture("filmstrip-metadata");
    const store = new DerivedMediaStore();
    await store.setProject(directory, project);
    const scope = store.scope();
    const first = await store.beginWrite(scope, {
      assetId: "asset_fixture",
      kind: "filmstrip",
      expectedBytes: 2,
    });
    await store.writeChunk(first.writerId, 0, new Uint8Array([1, 2]));
    await expect(
      store.finalizeWrite(first.writerId, {
        bytes: 2,
        tileTimesUs: [0, 100_000, 200_000],
        columns: 2,
        rows: 3,
        tileWidth: 160,
        tileHeight: 90,
      }),
    ).rejects.toThrow("inconsistent filmstrip metadata");
    await store.cancelWrite(first.writerId);

    const second = await store.beginWrite(scope, {
      assetId: "asset_fixture",
      kind: "filmstrip",
      expectedBytes: 2,
    });
    await store.writeChunk(second.writerId, 0, new Uint8Array([3, 4]));
    await store.finalizeWrite(second.writerId, {
      bytes: 2,
      tileTimesUs: [0, 100_000, 200_000],
      columns: 2,
      rows: 2,
      tileWidth: 160,
      tileHeight: 90,
    });
    expect(store.snapshot().assets.asset_fixture?.filmstrip).toMatchObject({
      state: "ready",
      columns: 2,
      rows: 2,
    });
  });

  it("queues and atomically publishes bounded waveforms for embedded and audio-only media", async () => {
    const { directory, project: videoProject } = await fixture("waveform");
    const sourcePath = join(directory, "source.mp4");
    const project = applyCommand(videoProject, {
      type: "asset.import",
      asset: {
        id: "asset_audio",
        kind: "audio",
        name: "source.mp4",
        source: { kind: "local", path: sourcePath },
        durationUs: 1_000_000,
      },
    }).project;
    const store = new DerivedMediaStore();
    await store.setProject(directory, project);
    const scope = store.scope();
    const queued = await store.requestJobs(scope, ["asset_fixture", "asset_audio"]);
    expect(queued.assets.asset_fixture?.waveform.state).toBe("queued");
    expect(queued.assets.asset_audio?.waveform.state).toBe("queued");
    expect(queued.assets.asset_audio?.thumbnail.state).toBe("missing");
    await expect(
      store.beginWrite(scope, {
        assetId: "asset_audio",
        kind: "waveform",
        expectedBytes: 20,
      }),
    ).rejects.toThrow("exact bounded artifact size");

    const minima = new Float32Array(20);
    const maxima = new Float32Array(20);
    minima[0] = -0.5;
    minima[19] = -1;
    maxima[0] = 0.25;
    maxima[19] = 1;
    const waveform = encodeWaveformEnvelope(minima, maxima);
    const { writerId } = await store.beginWrite(scope, {
      assetId: "asset_audio",
      kind: "waveform",
      expectedBytes: waveform.byteLength,
    });
    await store.writeChunk(writerId, 0, new Uint8Array(waveform));
    await store.finalizeWrite(writerId, {
      bytes: waveform.byteLength,
      peakCount: 20,
      waveformFormatVersion: WAVEFORM_FORMAT_VERSION,
    });

    const ready = store.snapshot().assets.asset_audio!.waveform;
    expect(ready).toMatchObject({
      state: "ready",
      bytes: waveform.byteLength,
      peakCount: 20,
      waveformFormatVersion: WAVEFORM_FORMAT_VERSION,
    });
    const artifact = await store.artifactFile(
      scope,
      "waveform",
      "asset_audio",
      undefined,
      ready.updatedAt,
    );
    expect(artifact).toMatchObject({
      size: waveform.byteLength,
      mimeType: "application/vnd.cinesim.waveform",
    });
  });

  it("rejects an exact-size waveform whose binary envelope is invalid", async () => {
    const { directory, project } = await fixture("waveform-invalid");
    const store = new DerivedMediaStore();
    await store.setProject(directory, project);
    const scope = store.scope();
    const peakCount = 20;
    const expectedBytes = 16 + peakCount * 4;
    const { writerId } = await store.beginWrite(scope, {
      assetId: "asset_fixture",
      kind: "waveform",
      expectedBytes,
    });
    await store.writeChunk(writerId, 0, new Uint8Array(expectedBytes));

    await expect(
      store.finalizeWrite(writerId, {
        bytes: expectedBytes,
        peakCount,
        waveformFormatVersion: WAVEFORM_FORMAT_VERSION,
      }),
    ).rejects.toThrow("Unknown waveform artifact");
    await store.cancelWrite(writerId, "invalid-waveform");
    expect(store.snapshot().assets.asset_fixture?.waveform.state).toBe("failed");

    await store.requestJobs(scope, ["asset_fixture"]);
    expect(store.snapshot().assets.asset_fixture?.waveform.state).toBe("failed");
  });

  it("rejects stale project work even when projects reuse the same IDs", async () => {
    const first = await fixture("scope-first");
    const second = await fixture("scope-second");
    const store = new DerivedMediaStore();
    await store.setProject(first.directory, first.project);
    const firstScope = store.scope();
    const retiredWriter = await store.beginWrite(firstScope, {
      assetId: "asset_fixture",
      kind: "thumbnail",
    });

    await store.setProject(second.directory, second.project);
    const secondScope = store.scope();
    expect(secondScope.cacheKey).not.toBe(firstScope.cacheKey);
    await expect(store.requestJobs(firstScope, ["asset_fixture"])).rejects.toThrow(
      "Stale derived media project scope",
    );
    await expect(store.updateProgress(retiredWriter.writerId, 0.5)).resolves.toBeUndefined();
    await expect(
      store.writeChunk(retiredWriter.writerId, 0, new Uint8Array([1])),
    ).resolves.toBeUndefined();
    await expect(
      store.finalizeWrite(retiredWriter.writerId, { bytes: 1 }),
    ).resolves.toBeUndefined();
    await expect(store.cancelWrite(retiredWriter.writerId)).resolves.toBeUndefined();
    expect(() =>
      store.reportActivity(firstScope, {
        jobId: "00000000-0000-4000-8000-000000000001",
        assetId: "asset_fixture",
        jobKind: "perception",
        stage: "thumbnail-sampling",
        elapsedMs: 25,
      }),
    ).not.toThrow();
    await expect(
      store.reportPerformance(firstScope, {
        assetId: "asset_fixture",
        sourceKind: "original",
        operation: "sampling",
        latencyMs: 25,
      }),
    ).resolves.toBeUndefined();
    expect(store.snapshot().runtime.activeJob).toBeUndefined();
    expect(store.snapshot().assets.asset_fixture?.performance.original.observations).toBe(0);

    await store.setProject(second.directory, second.project);
    const reopenedScope = store.scope();
    expect(reopenedScope.cacheKey).toBe(secondScope.cacheKey);
    expect(reopenedScope.epoch).not.toBe(secondScope.epoch);
    await expect(
      store.beginWrite(secondScope, { assetId: "asset_fixture", kind: "thumbnail" }),
    ).rejects.toThrow("Stale derived media project scope");
  });

  it("serializes persistence triggered by concurrent artifact reads", async () => {
    const first = await fixture("concurrent-access");
    const second = await fixture("concurrent-access-next");
    const store = new DerivedMediaStore();
    await store.setProject(first.directory, first.project);
    const scope = store.scope();
    const { writerId } = await store.beginWrite(scope, {
      assetId: "asset_fixture",
      kind: "thumbnail",
      expectedBytes: 2,
    });
    await store.writeChunk(writerId, 0, new Uint8Array([1, 2]));
    await store.finalizeWrite(writerId, { bytes: 2 });

    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.artifactFile(
          scope,
          "thumbnail",
          "asset_fixture",
          undefined,
          store.snapshot().assets.asset_fixture!.thumbnail.updatedAt,
        ),
      ),
    );
    await store.setProject(second.directory, second.project);

    await expect(
      readFile(join(first.directory, ".video", "cache", "media-intelligence.json"), "utf8"),
    ).resolves.toContain('"thumbnail"');
  });

  it("reuses a prepared index without rewriting unchanged project state", async () => {
    const { directory, project } = await fixture("prepared-open");
    const original = new DerivedMediaStore();
    await original.setProject(directory, project);
    const indexPath = join(directory, ".video", "cache", "media-intelligence.json");
    const before = await stat(indexPath);

    const store = new DerivedMediaStore();
    const prepared = await store.prepareProject(directory);
    await store.setProject(directory, project, prepared);
    await store.requestJobs(store.scope(), []);

    const after = await stat(indexPath);
    expect(after.ino).toBe(before.ino);
  });

  it("recovers interrupted jobs as queued after project open", async () => {
    const first = await fixture("recover-first");
    const second = await fixture("recover-second");
    const original = new DerivedMediaStore();
    await original.setProject(first.directory, first.project);
    await original.beginWrite(original.scope(), {
      assetId: "asset_fixture",
      kind: "filmstrip",
    });
    expect(original.snapshot().assets.asset_fixture?.filmstrip.state).toBe("running");
    await original.setProject(second.directory, second.project);

    const reopened = new DerivedMediaStore();
    await reopened.setProject(first.directory, first.project);
    expect(reopened.snapshot().assets.asset_fixture?.filmstrip.state).toBe("queued");
    expect(reopened.snapshot().decisionLog.at(-1)?.kind).toBe("jobs-recovered");
  });

  it("queues a proxy only after repeated unhealthy warmed seeks", async () => {
    const { directory, project } = await fixture("adaptive");
    const store = new DerivedMediaStore();
    await store.setProject(directory, project);
    const scope = store.scope();
    for (let index = 0; index < 5; index += 1) {
      await store.reportPerformance(scope, {
        assetId: "asset_fixture",
        sourceKind: "original",
        operation: "hover-seek",
        latencyMs: 180 + index,
        requestsReceived: 1,
      });
    }
    expect(store.snapshot().assets.asset_fixture).toMatchObject({
      proxy: { state: "queued" },
      performance: {
        decision: "proxy-queued",
        reasons: ["warm-seek-p95-over-budget"],
      },
    });
  });

  it("reports bounded worker and protocol runtime metrics", async () => {
    const { directory, project } = await fixture("runtime-metrics");
    const store = new DerivedMediaStore();
    await store.setProject(directory, project);
    store.reportActivity(store.scope(), {
      jobId: "00000000-0000-4000-8000-000000000001",
      assetId: "asset_fixture",
      jobKind: "perception",
      stage: "thumbnail-sampling",
      elapsedMs: 25,
      completedSamples: 2,
      totalSamples: 8,
    });
    store.recordProtocolRead({
      assetId: "asset_fixture",
      start: 0,
      requestedEnd: 1024,
      bytesRead: 1024,
      durationMs: 4,
      range: true,
    });

    expect(store.snapshot().runtime).toMatchObject({
      activeJob: {
        stage: "thumbnail-sampling",
        progress: 0.25,
        completedSamples: 2,
        totalSamples: 8,
      },
      protocol: {
        requests: 1,
        rangeRequests: 1,
        bytesRead: 1024,
        averageLatencyMs: 4,
        errors: 0,
      },
    });
  });
});

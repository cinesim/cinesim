import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import { DerivedMediaStore } from "../src/main/derived-media-store";

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
    await store.requestJobs(["asset_fixture"]);

    const { writerId } = await store.beginWrite({
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
    const artifact = await store.readArtifactRange("thumbnail", "asset_fixture", 1, 3);
    expect([...artifact.data]).toEqual([20, 30]);
    expect(artifact.size).toBe(4);
    expect(artifact.mimeType).toBe("image/jpeg");
  });

  it("validates writer bounds, ownership, and final sizes", async () => {
    const { directory, project } = await fixture("bounds");
    const store = new DerivedMediaStore();
    await store.setProject(directory, project);

    await expect(
      store.beginWrite({ assetId: "asset_fixture", kind: "proxy", profileId: "../bad" }),
    ).rejects.toThrow("Invalid proxy profile");
    const { writerId } = await store.beginWrite({
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

  it("recovers interrupted jobs as queued after project open", async () => {
    const first = await fixture("recover-first");
    const second = await fixture("recover-second");
    const original = new DerivedMediaStore();
    await original.setProject(first.directory, first.project);
    await original.beginWrite({ assetId: "asset_fixture", kind: "filmstrip" });
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
    for (let index = 0; index < 5; index += 1) {
      await store.reportPerformance({
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
});

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeUs, type Project } from "@cinesim/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExportRenderRequest } from "../src/shared/contracts";
import { ExportService } from "../src/main/exports/service";

const directories: string[] = [];

function project(): Project {
  return {
    id: "project_export",
    name: "Export",
    activeSequenceId: "sequence_main",
    assets: [],
    notes: [],
    sequences: [
      {
        id: "sequence_main",
        name: "Main",
        width: 3840,
        height: 2160,
        frameRate: 30,
        notes: [],
        tracks: [
          {
            id: "track_video",
            name: "Video",
            kind: "video",
            muted: false,
            locked: false,
            clips: [
              {
                id: "clip_video",
                assetId: "asset_video",
                mediaKind: "video",
                timelineStartUs: timeUs(0),
                durationUs: timeUs(2_000_000),
                sourceStartUs: timeUs(0),
                sourceEndUs: timeUs(2_000_000),
                transform: {
                  x: 0,
                  y: 0,
                  scaleX: 1,
                  scaleY: 1,
                  rotation: 0,
                  opacity: 1,
                  fit: "contain",
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup(dispatch: (request: ExportRenderRequest) => boolean = () => true) {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-export-"));
  directories.push(directory);
  const service = new ExportService(dispatch);
  await service.setProject({
    directory,
    project: project(),
    acceptedGeneration: "accepted-1",
    scope: { cacheKey: "scope", epoch: "1" },
  });
  return { directory, service };
}

describe("ExportService", () => {
  it("publishes bounded out-of-order chunks atomically", async () => {
    let dispatched: ExportRenderRequest | null = null;
    const { service } = await setup((request) => {
      dispatched = request;
      return true;
    });
    const job = await service.start({
      presetId: "h264-aac-sdr-1080p",
      startUs: timeUs(500_000),
      endUs: timeUs(1_500_000),
      fileName: "final.mp4",
    });
    expect(dispatched).toMatchObject({
      job: { id: job.id, width: 1920, height: 1080, acceptedGeneration: "accepted-1" },
    });
    await service.writeChunk(job.id, 3, new Uint8Array([4, 5]));
    await service.writeChunk(job.id, 0, new Uint8Array([1, 2, 3]));
    const completed = await service.complete({
      jobId: job.id,
      bytes: 5,
      videoFrames: 30,
      audioFrames: 48_000,
    });
    expect(completed).toMatchObject({ state: "completed", progress: 1, bytes: 5 });
    expect([...new Uint8Array(await readFile(completed.outputPath!))]).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects invalid ranges, overwrites, and unavailable renderers without partial files", async () => {
    const { directory, service } = await setup(() => false);
    await expect(
      service.start({
        presetId: "h264-aac-sdr-source",
        startUs: timeUs(1_000_000),
        endUs: timeUs(1_000_000),
      }),
    ).rejects.toThrow(/range/);
    await expect(
      service.start({ presetId: "h264-aac-sdr-source", fileName: "offline.mp4" }),
    ).rejects.toThrow(/renderer/);
    await expect(stat(join(directory, ".video", "exports", "offline.mp4"))).rejects.toThrow();
    expect(service.status()[0]).toMatchObject({
      state: "failed",
      failureCode: "renderer-unavailable",
    });
  });

  it("refuses to publish a sparse streamed artifact", async () => {
    const { directory, service } = await setup();
    const job = await service.start({
      presetId: "h264-aac-sdr-source",
      fileName: "sparse.mp4",
    });
    await service.writeChunk(job.id, 4, new Uint8Array([1, 2]));
    await expect(
      service.complete({ jobId: job.id, bytes: 6, videoFrames: 1, audioFrames: 1 }),
    ).rejects.toThrow(/byte count/);
    await service.fail(job.id, "invalid-stream", "Sparse export fixture");
    await expect(stat(join(directory, ".video", "exports", "sparse.mp4"))).rejects.toThrow();
  });
});

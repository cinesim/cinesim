import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudMediaManager } from "../src/main/cloud/manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("CloudMediaManager transfer journal", () => {
  it("loads interrupted work as paused and keeps completed part progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-cloud-journal-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "transfers.json");
    await writeFile(
      path,
      JSON.stringify([
        {
          assetId: "asset_fixture",
          cloudAssetId: "cloud_asset_fixture00000001",
          uploadId: "cloud_upload_fixture0000001",
          projectDirectory: "/project",
          sourcePath: "/media/source.mov",
          name: "source.mov",
          bytes: 1_000,
          uploadedBytes: 640,
          state: "uploading",
          error: null,
          checksumSha256: "a".repeat(64),
          sourceFingerprint: { size: 1_000, mtimeMs: 42, edgeHash: "b".repeat(64) },
        },
      ]),
    );
    const manager = new CloudMediaManager(path, {} as never, {} as never);

    await manager.load();

    expect(manager.snapshots()).toEqual([
      {
        assetId: "asset_fixture",
        cloudAssetId: "cloud_asset_fixture00000001",
        name: "source.mov",
        bytes: 1_000,
        uploadedBytes: 640,
        state: "paused",
        error: null,
      },
    ]);
  });

  it("ignores malformed local journal data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-cloud-journal-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "transfers.json");
    await writeFile(path, "not-json", "utf8");
    const manager = new CloudMediaManager(path, {} as never, {} as never);

    await manager.load();

    expect(manager.snapshots()).toEqual([]);
  });
});

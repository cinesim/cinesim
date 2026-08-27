import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudMediaManager } from "../src/main/cloud/manager";
import { applyCommand, createProject } from "@cinesim/core";

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
          userId: "user_fixture",
          cloudProjectId: "cloud_project_fixture0000001",
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
    const manager = new CloudMediaManager(
      path,
      { cachedUser: () => ({ id: "user_fixture" }) } as never,
      { directory: "/project" } as never,
    );

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
    const manager = new CloudMediaManager(
      path,
      { cachedUser: () => ({ id: "user_fixture" }) } as never,
      { directory: "/project" } as never,
    );

    await manager.load();

    expect(manager.snapshots()).toEqual([]);
  });

  it("queues a local original as waiting when its account is offline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-cloud-offline-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.mov");
    await writeFile(sourcePath, new Uint8Array([1, 2, 3]));
    let project = applyCommand(createProject({ name: "Fixture" }), {
      type: "project.attachCloud",
      cloudProjectId: "cloud_project_fixture0000001",
    }).project;
    project = applyCommand(project, {
      type: "asset.import",
      asset: {
        id: "asset_fixture",
        name: "source.mov",
        kind: "video",
        source: { kind: "local", path: sourcePath },
        durationUs: 1_000_000,
      },
    }).project;
    const account = {
      cachedUser: () => ({ id: "user_fixture" }),
      requireCachedUser: () => ({ id: "user_fixture" }),
      snapshot: async () => ({
        status: "offline",
        cloudStorage: false,
        user: { id: "user_fixture" },
      }),
    };
    const journalPath = join(directory, "transfers.json");
    const manager = new CloudMediaManager(
      journalPath,
      account as never,
      { directory, project } as never,
    );

    await expect(manager.queue(["asset_fixture"])).resolves.toMatchObject([
      { assetId: "asset_fixture", state: "waiting-for-cloud", uploadedBytes: 0 },
    ]);
    expect(await readFile(journalPath, "utf8")).toContain('"userId": "user_fixture"');
    expect(await readFile(journalPath, "utf8")).toContain(
      '"cloudProjectId": "cloud_project_fixture0000001"',
    );
  });

  it("rejects download URLs outside the private R2 endpoint", async () => {
    const account = {
      authenticatedFetch: async () =>
        new Response(JSON.stringify({ url: "https://example.com/original", bytes: 10 })),
    };
    const manager = new CloudMediaManager("/unused", account as never, {} as never);

    await expect(
      manager.readOriginal(
        "cloud_asset_fixture00000001",
        new Request("cinesim-media://asset/scope/asset_fixture"),
      ),
    ).rejects.toThrow("invalid signed URL");
  });

  it("validates account usage before exposing it to the renderer", async () => {
    const account = {
      authenticatedFetch: async () => new Response(JSON.stringify({ usedBytes: -1 })),
    };
    const manager = new CloudMediaManager("/unused", account as never, {} as never);

    await expect(manager.usage()).rejects.toThrow();
  });
});

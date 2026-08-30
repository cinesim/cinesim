import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudMediaManager } from "../src/main/cloud/manager";
import { MIN_MULTIPART_PART_BYTES } from "../src/main/cloud/limits";
import { timeUs, applyCommand, createProject } from "@cinesim/core";

const temporaryDirectories: string[] = [];

function signedDownloadUrl(path: string): string {
  const date = new Date();
  const encodedDate = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}Z`;
  return `https://fixture.r2.cloudflarestorage.com/${path}?X-Amz-Date=${encodedDate}&X-Amz-Expires=300`;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function completeUpload(managedSource: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-cloud-source-"));
  temporaryDirectories.push(directory);
  if (managedSource) await mkdir(join(directory, ".video", "originals"), { recursive: true });
  const sourcePath = managedSource
    ? join(directory, ".video", "originals", "asset_fixture")
    : join(directory, "source.mov");
  const sourceBytes = new Uint8Array([1, 2, 3]);
  await writeFile(sourcePath, sourceBytes);
  let project = createProject({
    name: "Fixture",
    cloudProjectId: "cloud_project_fixture0000001",
  });
  project = applyCommand(project, {
    type: "asset.import",
    asset: {
      id: "asset_fixture",
      name: "source.mov",
      kind: "video",
      source: { kind: "local", path: sourcePath },
      durationUs: timeUs(1_000_000),
    },
  }).project;
  const preparationOrder: string[] = [];
  const account = {
    cachedUser: () => ({ id: "user_fixture" }),
    requireCachedUser: () => ({ id: "user_fixture" }),
    snapshot: async () => ({
      status: "signed-in",
      cloudStorage: true,
      user: { id: "user_fixture" },
    }),
    registerProject: async () => ({ id: "cloud_project_fixture0000001" }),
    authenticatedFetch: async (path: string) => {
      if (path === "/api/v1/cloud/uploads") {
        preparationOrder.push("upload");
        return new Response(
          JSON.stringify({
            id: "cloud_upload_fixture0000001",
            cloudAssetId: "cloud_asset_fixture00000001",
            partSize: MIN_MULTIPART_PART_BYTES,
            bytes: sourceBytes.byteLength,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            parts: [],
          }),
        );
      }
      if (path.endsWith("/parts/sign"))
        return new Response(
          JSON.stringify({
            parts: [
              {
                partNumber: 1,
                url: "https://fixture.r2.cloudflarestorage.com/upload-part",
              },
            ],
          }),
        );
      return new Response(JSON.stringify({}));
    },
  };
  const projectStore = {
    directory,
    project,
    derivedMedia: {
      queuePerception: async () => {
        preparationOrder.push("queue-perception");
      },
      waitForPerception: async () => {
        preparationOrder.push("perception-ready");
      },
      queueProxy: async () => {
        preparationOrder.push("queue-proxy");
      },
      waitForProxy: async () => undefined,
    },
    execute: async (command: Parameters<typeof applyCommand>[1]) => {
      projectStore.project = applyCommand(projectStore.project, command).project;
      return projectStore.session();
    },
    session: () => ({ project: projectStore.project, directory }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { etag: '"0123456789abcdef0123456789abcdef"' },
        }),
      ),
    ),
  );
  const manager = new CloudMediaManager(
    join(directory, "transfers.json"),
    account as never,
    projectStore as never,
  );

  await manager.queue(["asset_fixture"], managedSource ? ["asset_fixture"] : []);
  await vi.waitFor(() => expect(projectStore.project.assets[0]?.source.kind).toBe("cloud"));
  await vi.waitFor(() => expect(manager.snapshots()[0]?.state).toBe("complete"));
  return { preparationOrder, projectStore, sourceBytes, sourcePath };
}

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
    let project = createProject({
      name: "Fixture",
      cloudProjectId: "cloud_project_fixture0000001",
    });
    project = applyCommand(project, {
      type: "asset.import",
      asset: {
        id: "asset_fixture",
        name: "source.mov",
        kind: "video",
        source: { kind: "local", path: sourcePath },
        durationUs: timeUs(1_000_000),
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

  it("keeps the user-owned import in place after cloud upload finalization", async () => {
    const { preparationOrder, projectStore, sourceBytes, sourcePath } = await completeUpload(false);

    expect(projectStore.project.assets[0]?.source).toEqual({
      kind: "cloud",
      cloudAssetId: "cloud_asset_fixture00000001",
    });
    expect(preparationOrder.slice(0, 4)).toEqual([
      "queue-perception",
      "perception-ready",
      "queue-proxy",
      "upload",
    ]);
    await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from(sourceBytes));
  });

  it("removes only a managed temporary staging copy after cloud upload", async () => {
    const { sourcePath } = await completeUpload(true);

    await expect(readFile(sourcePath)).rejects.toThrow();
  });

  it("keeps and removes only the disposable downloaded original", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-cloud-download-"));
    temporaryDirectories.push(directory);
    const downloadedBytes = new Uint8Array([4, 5, 6]);
    let project = createProject({
      name: "Fixture",
      cloudProjectId: "cloud_project_fixture0000001",
    });
    project = applyCommand(project, {
      type: "asset.import",
      asset: {
        id: "asset_fixture",
        name: "source.mov",
        kind: "video",
        source: { kind: "cloud", cloudAssetId: "cloud_asset_fixture00000001" },
        durationUs: timeUs(1_000_000),
      },
    }).project;
    const account = {
      authenticatedFetch: async () =>
        new Response(
          JSON.stringify({
            url: signedDownloadUrl("original"),
            bytes: downloadedBytes.byteLength,
          }),
        ),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(downloadedBytes)),
    );
    const manager = new CloudMediaManager(
      join(directory, "transfers.json"),
      account as never,
      { directory, project } as never,
    );

    await expect(manager.keepDownloaded("asset_fixture")).resolves.toEqual(["asset_fixture"]);
    const downloadedPath = join(directory, ".video", "originals", "asset_fixture");
    await expect(readFile(downloadedPath)).resolves.toEqual(Buffer.from(downloadedBytes));
    await expect(manager.removeDownload("asset_fixture")).resolves.toEqual([]);
    await expect(readFile(downloadedPath)).rejects.toThrow();
  });

  it("refuses to remove a download through a symlinked originals directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-cloud-contained-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "cinesim-cloud-outside-"));
    temporaryDirectories.push(directory, outsideDirectory);
    await mkdir(join(directory, ".video"));
    await symlink(outsideDirectory, join(directory, ".video", "originals"), "dir");
    const outsidePath = join(outsideDirectory, "asset_fixture");
    await writeFile(outsidePath, new Uint8Array([7, 8, 9]));
    let project = createProject({
      name: "Fixture",
      cloudProjectId: "cloud_project_fixture0000001",
    });
    project = applyCommand(project, {
      type: "asset.import",
      asset: {
        id: "asset_fixture",
        name: "source.mov",
        kind: "video",
        source: { kind: "cloud", cloudAssetId: "cloud_asset_fixture00000001" },
        durationUs: timeUs(1_000_000),
      },
    }).project;
    const manager = new CloudMediaManager(
      join(directory, "transfers.json"),
      {} as never,
      { directory, project } as never,
    );

    await expect(manager.removeDownload("asset_fixture")).rejects.toThrow("must stay inside");
    await expect(readFile(outsidePath)).resolves.toEqual(Buffer.from([7, 8, 9]));
  });
});

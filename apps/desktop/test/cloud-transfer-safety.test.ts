import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudStorageGateway } from "../src/main/cloud/gateway";
import type { CloudUpload } from "../src/main/cloud/gateway";
import {
  MAX_CLOUD_JSON_BYTES,
  MAX_MULTIPART_PARTS,
  MIN_MULTIPART_PART_BYTES,
} from "../src/main/cloud/limits";
import { MultipartUploader } from "../src/main/cloud/multipart-uploader";
import { CloudUploadScheduler } from "../src/main/cloud/upload-scheduler";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function uploadFixture(overrides: Partial<CloudUpload> = {}): CloudUpload {
  return {
    id: "cloud_upload_fixture0000001",
    cloudAssetId: "cloud_asset_fixture00000001",
    partSize: MIN_MULTIPART_PART_BYTES,
    bytes: MIN_MULTIPART_PART_BYTES,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    parts: [],
    ...overrides,
  };
}

describe("cloud transfer resource policy", () => {
  it("runs at most two asset uploads globally and can remove pending work", async () => {
    const scheduler = new CloudUploadScheduler();
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let settled = 0;
    for (let index = 0; index < gates.length; index += 1) {
      scheduler.enqueue({
        key: `upload-${index}`,
        run: async () => {
          active += 1;
          started += 1;
          maximumActive = Math.max(maximumActive, active);
          await gates[index]!.promise;
          active -= 1;
        },
        settled: () => {
          settled += 1;
        },
      });
    }
    scheduler.cancel("upload-4");
    await vi.waitFor(() => expect(started).toBe(2));
    gates[0]!.resolve();
    gates[1]!.resolve();
    await vi.waitFor(() => expect(started).toBe(4));
    gates[2]!.resolve();
    gates[3]!.resolve();
    await vi.waitFor(() => expect(settled).toBe(4));
    expect(maximumActive).toBe(2);
    expect(scheduler.has("upload-4")).toBe(false);
  });

  it("bounds cloud JSON before parsing and multipart sizes during schema validation", async () => {
    const oversized = new CloudStorageGateway({
      authenticatedFetch: async () =>
        new Response("{}", {
          headers: { "content-length": String(MAX_CLOUD_JSON_BYTES + 1) },
        }),
    });
    await expect(oversized.usage()).rejects.toThrow(/size limit/);

    const invalidPartSize = new CloudStorageGateway({
      authenticatedFetch: async () =>
        Response.json(uploadFixture({ partSize: MIN_MULTIPART_PART_BYTES - 1 })),
    });
    await expect(invalidPartSize.createUpload({})).rejects.toThrow();
  });

  it("requires the storage service to sign exactly the requested part set", async () => {
    const gateway = new CloudStorageGateway({
      authenticatedFetch: async () =>
        Response.json({
          parts: [
            {
              partNumber: 2,
              url: "https://fixture.r2.cloudflarestorage.com/part-2",
            },
          ],
        }),
    });
    await expect(
      gateway.signParts("cloud_upload_fixture0000001", [1], new AbortController().signal),
    ).rejects.toThrow(/unexpected multipart set/);
  });

  it("uses the signed URL's authoritative expiry", async () => {
    const signedAt = new Date();
    const date = `${signedAt.getUTCFullYear()}${String(signedAt.getUTCMonth() + 1).padStart(2, "0")}${String(signedAt.getUTCDate()).padStart(2, "0")}T${String(signedAt.getUTCHours()).padStart(2, "0")}${String(signedAt.getUTCMinutes()).padStart(2, "0")}${String(signedAt.getUTCSeconds()).padStart(2, "0")}Z`;
    const gateway = new CloudStorageGateway({
      authenticatedFetch: async () =>
        Response.json({
          url: `https://fixture.r2.cloudflarestorage.com/original?X-Amz-Date=${date}&X-Amz-Expires=300`,
          bytes: 42,
        }),
    });
    const download = await gateway.download("cloud_asset_fixture00000001");
    expect(download.expiresAt).toBeGreaterThan(Date.now() + 299_000);
    expect(download.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it("caps allocated multipart buffers across concurrent assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-cloud-bounds-"));
    directories.push(directory);
    const sourceBytes = MIN_MULTIPART_PART_BYTES * 4;
    const paths = [join(directory, "first.mov"), join(directory, "second.mov")];
    await Promise.all(
      paths.map(async (path) => {
        await writeFile(path, "");
        await truncate(path, sourceBytes);
      }),
    );
    let activeParts = 0;
    let maximumActiveParts = 0;
    const release = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        activeParts += 1;
        maximumActiveParts = Math.max(maximumActiveParts, activeParts);
        if (activeParts === 3) release.resolve();
        await release.promise;
        activeParts -= 1;
        return new Response(null, {
          status: 200,
          headers: { etag: '"0123456789abcdef0123456789abcdef"' },
        });
      }),
    );
    const gateway = {
      signParts: async (_uploadId: string, partNumbers: readonly number[]) =>
        partNumbers.map((partNumber) => ({
          partNumber,
          url: `https://fixture.r2.cloudflarestorage.com/${partNumber}`,
        })),
      recordPart: async () => undefined,
    };
    const uploader = new MultipartUploader(gateway);
    await Promise.all(
      paths.map((sourcePath, index) =>
        uploader.upload({
          upload: uploadFixture({
            id: `cloud_upload_fixture000000${index + 1}`,
            cloudAssetId: `cloud_asset_fixture0000000${index + 1}`,
            bytes: sourceBytes,
          }),
          sourcePath,
          sourceBytes,
          signal: new AbortController().signal,
          onPartComplete: () => undefined,
        }),
      ),
    );
    expect(maximumActiveParts).toBe(3);
  });

  it("rejects uploads whose server-provided part size creates too many parts", async () => {
    const uploader = new MultipartUploader({
      signParts: async () => [],
      recordPart: async () => undefined,
    });
    const sourceBytes = MIN_MULTIPART_PART_BYTES * (MAX_MULTIPART_PARTS + 1);
    await expect(
      uploader.upload({
        upload: uploadFixture({ bytes: sourceBytes }),
        sourcePath: "/unused",
        sourceBytes,
        signal: new AbortController().signal,
        onPartComplete: () => undefined,
      }),
    ).rejects.toThrow(/multipart count limit/);
  });
});

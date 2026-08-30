import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudOriginalReader } from "../src/main/cloud/original-reader";

afterEach(() => {
  vi.unstubAllGlobals();
});

function reader(bytes = 10) {
  const download = vi.fn(async () => ({
    url: "https://fixture.r2.cloudflarestorage.com/original",
    bytes,
    expiresAt: Date.now() + 60_000,
  }));
  return {
    download,
    reader: new CloudOriginalReader({ download } as never),
  };
}

describe("CloudOriginalReader", () => {
  it("answers HEAD ranges without downloading the object", async () => {
    const { reader: originalReader } = reader();
    const fetchOriginal = vi.fn();
    vi.stubGlobal("fetch", fetchOriginal);

    const response = await originalReader.read(
      "cloud_asset_fixture00000001",
      new Request("cinesim-media://asset/scope/asset_fixture", {
        method: "HEAD",
        headers: { range: "bytes=2-4" },
      }),
      "cinesim://app",
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(response.headers.get("access-control-allow-origin")).toBe("cinesim://app");
    expect(fetchOriginal).not.toHaveBeenCalled();
  });

  it("forwards a bounded GET range and only exposes safe media headers", async () => {
    const { reader: originalReader } = reader();
    const fetchOriginal = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("range")).toBe("bytes=2-4");
      return new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          etag: '"0123456789abcdef0123456789abcdef"',
          "x-private-header": "hidden",
        },
      });
    });
    vi.stubGlobal("fetch", fetchOriginal);

    const response = await originalReader.read(
      "cloud_asset_fixture00000001",
      new Request("cinesim-media://asset/scope/asset_fixture", {
        headers: { range: "bytes=2-4" },
      }),
      "cinesim://app",
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("etag")).toBe('"0123456789abcdef0123456789abcdef"');
    expect(response.headers.has("x-private-header")).toBe(false);
    await expect(response.bytes()).resolves.toEqual(new Uint8Array([2, 3, 4]));
  });

  it("rejects unsupported methods and unsatisfied ranges before fetching", async () => {
    const { reader: originalReader, download } = reader();
    const fetchOriginal = vi.fn();
    vi.stubGlobal("fetch", fetchOriginal);

    const methodResponse = await originalReader.read(
      "cloud_asset_fixture00000001",
      new Request("cinesim-media://asset/scope/asset_fixture", { method: "POST" }),
      "cinesim://app",
    );
    const rangeResponse = await originalReader.read(
      "cloud_asset_fixture00000001",
      new Request("cinesim-media://asset/scope/asset_fixture", {
        headers: { range: "bytes=20-30" },
      }),
      "cinesim://app",
    );

    expect(methodResponse.status).toBe(405);
    expect(rangeResponse.status).toBe(416);
    expect(download).toHaveBeenCalledOnce();
    expect(fetchOriginal).not.toHaveBeenCalled();
  });
});

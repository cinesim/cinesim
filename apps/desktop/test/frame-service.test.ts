import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { timeUs } from "@cinesim/core";
import { applyCommand, createProject } from "../../../packages/core/test/project-fixtures";
import type { FrameRenderRequest } from "../src/shared/contracts";
import { FrameService, boundedFrameSize } from "../src/main/frames/service";

const temporaryDirectories: string[] = [];
const scope = {
  cacheKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
  epoch: "00000000-0000-4000-8000-000000000001",
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-frames-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "source.mp4");
  await writeFile(sourcePath, new Uint8Array([1, 2, 3, 4]));
  const project = applyCommand(createProject({ name: "Frames" }), {
    type: "asset.import",
    asset: {
      id: "asset_fixture",
      kind: "video",
      name: "source.mp4",
      source: { kind: "local", path: sourcePath },
      durationUs: timeUs(2_000_000),
      width: 3840,
      height: 2160,
      frameRate: 30,
    },
  }).project;
  return { directory, project };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("FrameService", () => {
  it("normalizes, bounds, publishes, and reuses exact asset frames", async () => {
    const { directory, project } = await fixture();
    const requests: FrameRenderRequest[] = [];
    const service = new FrameService(
      (request) => {
        requests.push(request);
        return true;
      },
      async () => ({ size: 4, mtimeMs: 1, edgeHash: "source-a" }),
    );
    service.setProject({ directory, project, acceptedGeneration: "generation-a", scope });

    const first = service.get({ kind: "asset", assetId: "asset_fixture" }, 510_000, "medium");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      normalizedTimeUs: timeUs(500_000),
      width: 1280,
      height: 720,
    });
    await service.complete(scope, {
      requestId: requests[0]!.requestId,
      renderedTimeUs: timeUs(500_001),
      width: 1280,
      height: 720,
      png: new Uint8Array([137, 80, 78, 71]),
    });
    await expect(first).resolves.toMatchObject({
      requestedTimeUs: timeUs(510_000),
      normalizedTimeUs: timeUs(500_000),
      renderedTimeUs: timeUs(500_001),
      quality: "medium",
      cached: false,
      derived: true,
    });

    await expect(
      service.get({ kind: "asset", assetId: "asset_fixture" }, 520_000, "medium"),
    ).resolves.toMatchObject({
      requestedTimeUs: timeUs(520_000),
      normalizedTimeUs: timeUs(500_000),
      cached: true,
    });
    expect(requests).toHaveLength(1);
    const metadata = JSON.parse(
      await readFile(
        join(directory, ".video", "frames", "asset_fixture-500000-medium.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("requestedTimeUs");
    expect(metadata).not.toHaveProperty("updatedAt");
  });

  it("invalidates timeline frames when the accepted generation changes", async () => {
    const { directory, project } = await fixture();
    const requests: FrameRenderRequest[] = [];
    const service = new FrameService(
      (request) => {
        requests.push(request);
        return true;
      },
      async () => ({ size: 4, mtimeMs: 1, edgeHash: "source-a" }),
    );
    const target = { kind: "timeline" as const, sequenceId: project.activeSequenceId };
    service.setProject({ directory, project, acceptedGeneration: "generation-a", scope });
    const first = service.get(target, 100_000, "low");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await service.complete(scope, {
      requestId: requests[0]!.requestId,
      renderedTimeUs: requests[0]!.normalizedTimeUs,
      width: requests[0]!.width,
      height: requests[0]!.height,
      png: new Uint8Array([1, 2, 3]),
    });
    await first;

    service.setProject({ directory, project, acceptedGeneration: "generation-b", scope });
    const second = service.get(target, 100_000, "low");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await service.complete(scope, {
      requestId: requests[1]!.requestId,
      renderedTimeUs: requests[1]!.normalizedTimeUs,
      width: requests[1]!.width,
      height: requests[1]!.height,
      png: new Uint8Array([4, 5, 6]),
    });
    await expect(second).resolves.toMatchObject({ acceptedGeneration: "generation-b" });
  });

  it("rejects invalid targets and renderer output outside the request contract", async () => {
    const { directory, project } = await fixture();
    const requests: FrameRenderRequest[] = [];
    const service = new FrameService(
      (request) => {
        requests.push(request);
        return true;
      },
      async () => ({ size: 4, mtimeMs: 1, edgeHash: "source-a" }),
    );
    service.setProject({ directory, project, acceptedGeneration: "generation-a", scope });
    await expect(service.get({ kind: "asset", assetId: "asset_missing" }, 0)).rejects.toThrow(
      "Unknown asset",
    );

    const pending = service.get({ kind: "asset", assetId: "asset_fixture" }, 0, "high");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await expect(
      service.complete(scope, {
        requestId: requests[0]!.requestId,
        renderedTimeUs: timeUs(0),
        width: requests[0]!.width - 2,
        height: requests[0]!.height,
        png: new Uint8Array([1]),
      }),
    ).rejects.toThrow("dimensions");
    await expect(pending).rejects.toThrow("dimensions");
    expect(boundedFrameSize(1080, 1920, "low")).toEqual({ width: 360, height: 640 });
  });
});

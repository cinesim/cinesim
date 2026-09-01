import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeUs } from "@cinesim/core";
import { sourceFingerprintForPath, VisualIndexStore } from "@cinesim/project-io";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { applyCommand, createProject } from "../../../packages/core/test/project-fixtures";
import { VisualAnalysisService } from "../src/main/visual-analysis/service";
import type { VisualAnalysisRequest } from "../src/shared/contracts";

const directories: string[] = [];
const scope = {
  cacheKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
  epoch: "00000000-0000-4000-8000-000000000001",
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-visual-analysis-"));
  directories.push(directory);
  const mediaPath = join(directory, "source.mp4");
  await writeFile(mediaPath, new Uint8Array([1, 2, 3, 4]));
  const project = applyCommand(createProject({ name: "Visual analysis" }), {
    type: "asset.import",
    asset: {
      id: "asset_fixture",
      kind: "video",
      name: "source.mp4",
      source: { kind: "local", path: mediaPath },
      durationUs: timeUs(4_000_000),
      width: 1280,
      height: 720,
      frameRate: 24,
    },
  }).project;
  const store = new VisualIndexStore(() => sourceFingerprintForPath(mediaPath));
  store.setProject(directory, project);
  const requests: VisualAnalysisRequest[] = [];
  const canceled: string[] = [];
  const service = new VisualAnalysisService(
    store,
    (request) => {
      requests.push(request);
      return true;
    },
    (requestId) => canceled.push(requestId),
  );
  service.setProject({ project, acceptedGeneration: "generation-a", scope });
  return { service, store, requests, canceled, project };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("VisualAnalysisService", () => {
  it("deduplicates renderer work and atomically publishes generated observations", async () => {
    const { service, store, requests } = await fixture();
    const first = service.generate(["asset_fixture"]);
    const second = service.generate(["asset_fixture"]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      assetId: "asset_fixture",
      durationUs: timeUs(4_000_000),
      acceptedGeneration: "generation-a",
      projectScope: scope,
    });

    await service.complete(scope, {
      requestId: requests[0]!.requestId,
      options: { analyzer: "fixture-v1", sampleCount: 2 },
      coverage: [{ sourceInUs: 0, sourceOutUs: timeUs(4_000_000) }],
      observations: [
        {
          id: "observation_auto_fixture",
          sourceInUs: timeUs(0),
          sourceOutUs: timeUs(4_000_000),
          description: "Mid-tone imagery with moderate visual change.",
          provenance: "fixture-v1",
        },
      ],
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      [expect.objectContaining({ state: "current", observationCount: 1 })],
      [expect.objectContaining({ state: "current", observationCount: 1 })],
    ]);
    await expect(store.get("asset_fixture")).resolves.toMatchObject({
      observations: [{ id: "observation_auto_fixture" }],
    });
  });

  it("reuses a populated current index unless regeneration is forced", async () => {
    const { service, store, requests } = await fixture();
    await store.upsert("asset_fixture", [
      {
        id: "observation_manual",
        sourceInUs: 0,
        sourceOutUs: 1_000_000,
        description: "Manual evidence",
      },
    ]);

    await expect(service.generate(["asset_fixture"])).resolves.toMatchObject([
      { state: "current", observationCount: 1 },
    ]);
    expect(requests).toHaveLength(0);

    const forced = service.generate(["asset_fixture"], true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await service.complete(scope, {
      requestId: requests[0]!.requestId,
      options: { analyzer: "fixture-v2" },
      coverage: [{ sourceInUs: 0, sourceOutUs: 2_000_000 }],
      observations: [
        {
          id: "observation_generated",
          sourceInUs: 0,
          sourceOutUs: 2_000_000,
          description: "Generated evidence",
        },
      ],
    });
    await expect(forced).resolves.toMatchObject([{ observationCount: 1 }]);
    await expect(store.get("asset_fixture")).resolves.toMatchObject({
      observations: [{ id: "observation_generated" }],
    });
  });

  it("rejects stale completion scopes and cancels pending work on project changes", async () => {
    const { service, requests, canceled, project } = await fixture();
    const pending = service.generate(["asset_fixture"]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await expect(
      service.complete(
        { ...scope, epoch: "00000000-0000-4000-8000-000000000002" },
        {
          requestId: requests[0]!.requestId,
          options: {},
          coverage: [],
          observations: [],
        },
      ),
    ).rejects.toThrow("Stale visual-analysis project scope");

    service.setProject({ project, acceptedGeneration: "generation-b", scope });
    await expect(pending).rejects.toThrow("open project changed");
    expect(canceled).toEqual([requests[0]!.requestId]);
  });
});

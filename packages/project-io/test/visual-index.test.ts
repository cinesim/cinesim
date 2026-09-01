import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeUs } from "@cinesim/core";
import { createProject } from "../../core/test/project-fixtures";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { sourceFingerprintForPath, VisualIndexStore } from "../src";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture(onChanged: () => void = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-visual-index-"));
  directories.push(directory);
  const mediaPath = join(directory, "camera.mov");
  await writeFile(mediaPath, "first source");
  const project = createProject({ name: "Visual index" });
  project.assets.push({
    id: "asset_camera",
    kind: "video",
    name: "Camera",
    source: { kind: "local", path: mediaPath },
    durationUs: timeUs(10_000_000),
    width: 1920,
    height: 1080,
    frameRate: 24,
    hasAudio: true,
  });
  const store = new VisualIndexStore(async () => sourceFingerprintForPath(mediaPath), onChanged);
  store.setProject(directory, project);
  return { directory, mediaPath, store };
}

describe("VisualIndexStore", () => {
  it("keeps bounded deterministic disposable observations and detects staleness", async () => {
    const { directory, mediaPath, store } = await fixture();
    await expect(store.status(["asset_camera"])).resolves.toEqual([
      { assetId: "asset_camera", state: "missing", observationCount: 0, coverage: [] },
    ]);
    await expect(access(join(directory, ".video"))).rejects.toMatchObject({ code: "ENOENT" });

    await store.generate(["asset_camera"]);
    await store.upsert("asset_camera", [
      {
        id: "observation_second",
        sourceInUs: 2_000_000,
        sourceOutUs: 4_000_000,
        description: "A runner crosses frame",
        tags: ["wide", "action", "wide"],
        confidence: 0.8,
      },
      {
        id: "observation_first",
        sourceInUs: 0,
        sourceOutUs: 2_000_000,
        description: "Establishing shot",
        shotType: "wide",
      },
    ]);
    await expect(
      store.get("asset_camera", { fromUs: 1_000_000, toUs: 3_000_000 }),
    ).resolves.toMatchObject({
      status: {
        state: "current",
        observationCount: 2,
        coverage: [{ sourceInUs: 0, sourceOutUs: 4_000_000 }],
      },
      observations: [
        { id: "observation_first" },
        { id: "observation_second", tags: ["action", "wide"] },
      ],
      truncated: false,
    });
    const artifactSource = await readFile(
      join(directory, ".video", "visual-index", "asset_camera.json"),
      "utf8",
    );
    expect(artifactSource).not.toMatch(/created|updated|timestamp/iu);

    await writeFile(mediaPath, "changed source with a different size");
    await expect(store.status(["asset_camera"])).resolves.toMatchObject([{ state: "stale" }]);
    await store.upsert("asset_camera", [
      {
        id: "observation_replacement",
        sourceInUs: 5_000_000,
        sourceOutUs: 6_000_000,
        description: "Replacement observation",
      },
    ]);
    await expect(store.get("asset_camera")).resolves.toMatchObject({
      status: { state: "current", observationCount: 1 },
      observations: [{ id: "observation_replacement" }],
    });
  });

  it("deletes by ID or range, clears artifacts, and rejects invalid records", async () => {
    const { store } = await fixture();
    await store.upsert("asset_camera", [
      {
        id: "observation_one",
        sourceInUs: 0,
        sourceOutUs: 1_000_000,
        description: "One",
      },
      {
        id: "observation_two",
        sourceInUs: 2_000_000,
        sourceOutUs: 3_000_000,
        description: "Two",
      },
    ]);
    await store.delete("asset_camera", { observationIds: ["observation_one"] });
    await expect(store.get("asset_camera")).resolves.toMatchObject({
      observations: [{ id: "observation_two" }],
    });
    await store.delete("asset_camera", { fromUs: 1_500_000, toUs: 3_500_000 });
    await expect(store.get("asset_camera")).resolves.toMatchObject({ observations: [] });
    await expect(
      store.upsert("asset_camera", [
        { id: "bad", sourceInUs: 0, sourceOutUs: 1, description: "Invalid ID" },
      ]),
    ).rejects.toThrow("observation_ prefix");
    await store.clear(["asset_camera"]);
    await expect(store.status(["asset_camera"])).resolves.toMatchObject([{ state: "missing" }]);
  });

  it("notifies every shared UI or service consumer after derived artifacts change", async () => {
    let changes = 0;
    const { store } = await fixture(() => {
      changes += 1;
    });
    await store.generate(["asset_camera"]);
    await store.upsert("asset_camera", [
      {
        id: "observation_one",
        sourceInUs: 0,
        sourceOutUs: 1_000_000,
        description: "One",
      },
    ]);
    await store.clear(["asset_camera"]);
    expect(changes).toBe(3);
  });

  it("atomically replaces generated options, coverage, and observations", async () => {
    const { store } = await fixture();
    await store.upsert("asset_camera", [
      {
        id: "observation_old",
        sourceInUs: 0,
        sourceOutUs: 1_000_000,
        description: "Old",
      },
    ]);

    await expect(
      store.replaceGenerated("asset_camera", {
        options: { analyzer: "local-v1", sampleCount: 5 },
        coverage: [{ sourceInUs: 0, sourceOutUs: 10_000_000 }],
        observations: [
          {
            id: "observation_generated",
            sourceInUs: 0,
            sourceOutUs: 10_000_000,
            description: "Bounded visual evidence",
          },
        ],
      }),
    ).resolves.toMatchObject({ state: "current", observationCount: 1 });
    await expect(store.get("asset_camera")).resolves.toMatchObject({
      status: { coverage: [{ sourceInUs: 0, sourceOutUs: 10_000_000 }] },
      observations: [{ id: "observation_generated" }],
    });
  });
});

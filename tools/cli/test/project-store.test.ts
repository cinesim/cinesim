import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceProjectRepository } from "@cinesim/project-io";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DiskProjectStore } from "../src/project-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("DiskProjectStore", () => {
  it("parses untrusted commands before invoking core or persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-cli-store-test-"));
    temporaryDirectories.push(directory);
    await SourceProjectRepository.create(directory, {
      id: "project_cli_fixture",
      name: "CLI fixture",
    });
    const store = await new DiskProjectStore(directory).load();
    expect(store.program).toMatchObject({ version: 2, projectId: "project_cli_fixture" });
    expect(store.editMap).toMatchObject({ version: 2, entry: "main.jsx" });

    await expect(
      store.execute({ type: "asset.remove", assetIds: ["asset_good/../../outside"] }),
    ).rejects.toThrow();
    expect(store.project.assets).toEqual([]);
    await expect(new DiskProjectStore(directory).load()).resolves.toMatchObject({
      project: { assets: [] },
    });
  });

  it("does not publish its in-memory command result after a stale write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-cli-store-test-"));
    temporaryDirectories.push(directory);
    await SourceProjectRepository.create(directory, {
      id: "project_cli_fixture",
      name: "CLI fixture",
    });
    const first = await new DiskProjectStore(directory).load();
    const stale = await new DiskProjectStore(directory).load();
    await first.execute({
      type: "asset.import",
      asset: {
        id: "asset_cli_first",
        kind: "audio",
        name: "First",
        source: { kind: "local", path: join(directory, "first.wav") },
        durationUs: 1_000_000,
      },
    });

    await expect(
      stale.execute({
        type: "asset.import",
        asset: {
          id: "asset_cli_stale",
          kind: "audio",
          name: "Stale",
          source: { kind: "local", path: join(directory, "stale.wav") },
          durationUs: 1_000_000,
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_PROJECT_CONFLICT" });
    expect(stale.project.assets).toEqual([]);
    await expect(new DiskProjectStore(directory).load()).resolves.toMatchObject({
      project: { assets: [expect.objectContaining({ id: "asset_cli_first" })] },
    });
  });
});

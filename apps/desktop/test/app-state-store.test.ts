import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAppStateStore } from "../src/main/app-state-store";

const temporaryDirectories: string[] = [];

async function stateFixture(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-app-state-test-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "ui-state.json") };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("DesktopAppStateStore", () => {
  it("starts empty and persists recent projects without timestamp churn", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    expect(store.snapshot()).toEqual({ version: 1, recentProjects: [], projectViews: {} });

    await store.rememberProject({ name: "First", directory: "/films/first" });
    await store.rememberProject({ name: "Second", directory: "/films/second" });
    await store.rememberProject({ name: "First renamed", directory: "/films/first" });

    expect(store.snapshot().recentProjects).toEqual([
      { name: "First renamed", directory: "/films/first" },
      { name: "Second", directory: "/films/second" },
    ]);
    expect(await readFile(path, "utf8")).not.toContain("timestamp");
  });

  it("restores open timeline tabs per project", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    await store.setProjectView("/films/first", {
      openSequenceIds: ["sequence_1", "sequence_2"],
      activeTab: "sequence_2",
    });

    const restored = new DesktopAppStateStore(path);
    await restored.load();
    expect(restored.snapshot().projectViews["/films/first"]).toEqual({
      openSequenceIds: ["sequence_1", "sequence_2"],
      activeTab: "sequence_2",
    });
  });

  it("recovers from invalid app state instead of affecting project data", async () => {
    const { path } = await stateFixture();
    await writeFile(path, "not json", "utf8");
    const store = new DesktopAppStateStore(path);
    await store.load();
    expect(store.snapshot()).toEqual({ version: 1, recentProjects: [], projectViews: {} });
  });
});

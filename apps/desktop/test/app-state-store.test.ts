import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DesktopAppStateStore } from "../src/main/state/app-state-store";

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
  it("keeps local projects device-wide and cloud projects account-scoped", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    await store.rememberProject({ name: "Local", directory: "/films/local", kind: "local" });
    store.setAccount("user_one");
    await store.rememberProject({ name: "First", directory: "/films/first", kind: "cloud" });
    store.setAccount("user_two");
    await store.rememberProject({ name: "Second", directory: "/films/second", kind: "cloud" });

    const restored = new DesktopAppStateStore(path);
    await restored.load();
    expect(restored.snapshot().recentProjects).toEqual([
      { name: "Local", directory: "/films/local", kind: "local" },
    ]);
    restored.setAccount("user_one");
    expect(restored.snapshot().recentProjects).toEqual([
      { name: "First", directory: "/films/first", kind: "cloud" },
      { name: "Local", directory: "/films/local", kind: "local" },
    ]);
    restored.setAccount("user_two");
    expect(restored.snapshot().recentProjects).toEqual([
      { name: "Second", directory: "/films/second", kind: "cloud" },
      { name: "Local", directory: "/films/local", kind: "local" },
    ]);
    expect(await readFile(path, "utf8")).not.toContain("timestamp");
  });

  it("allows signed-out local state but requires an account for cloud state", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    expect(store.snapshot().recentProjects).toEqual([]);
    await store.rememberProject({ name: "Local", directory: "/films/local", kind: "local" });
    await store.setMediaPoolOpen("/films/local", false);
    expect(store.snapshot().mediaPoolOpenByProject["/films/local"]).toBe(false);
    await expect(
      store.rememberProject({ name: "Cloud", directory: "/films/cloud", kind: "cloud" }),
    ).rejects.toThrow("cloud project state");
  });

  it("keeps transcription preferences scoped to the signed-in account", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    await expect(
      store.setTranscriptionSettings({
        generation: "automatic",
        model: "deepgram/nova-3",
      }),
    ).rejects.toThrow(/cloud project state/);

    store.setAccount("user_one");
    await store.setTranscriptionSettings({
      generation: "automatic",
      model: "deepgram/nova-3",
    });
    expect(store.snapshot().transcriptionSettings.generation).toBe("automatic");

    store.setAccount("user_two");
    expect(store.snapshot().transcriptionSettings).toEqual({
      generation: "manual",
      model: "deepgram/nova-3",
    });
  });

  it("does not migrate the prior account-only state shape", async () => {
    const { path } = await stateFixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        accounts: {
          user_one: {
            version: 1,
            recentProjects: [{ name: "Legacy", directory: "/films/legacy" }],
          },
        },
      }),
    );
    const store = new DesktopAppStateStore(path);
    await store.load();
    store.setAccount("user_one");
    expect(store.snapshot().recentProjects).toEqual([]);
  });

  it("forgets a local project and its device-specific UI preferences", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    await store.rememberProject({ name: "First", directory: "/films/first", kind: "local" });
    await store.setMediaPoolOpen("/films/first", false);
    await store.setInspectorOpen("/films/first", false);
    await store.setNotesOpen("/films/first", false);
    await store.setEditorLayout("/films/first", {
      mediaPoolWidth: 300,
      inspectorWidth: 300,
      notesWidth: 300,
      timelineHeight: 300,
    });
    await store.setCutLayout("/films/first", {
      rightColumnWidth: 440,
      viewerHeight: 340,
      timelineHeight: 80,
    });

    await store.forgetProject("/films/first");
    expect(store.snapshot()).toEqual({
      version: 1,
      recentProjects: [],
      mediaPoolOpenByProject: {},
      inspectorOpenByProject: {},
      notesOpenByProject: {},
      editorLayoutsByProject: {},
      cutLayoutsByProject: {},
      transcriptionSettings: {
        generation: "manual",
        model: "deepgram/nova-3",
      },
    });
  });
});

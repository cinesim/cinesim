import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  it("persists recent projects separately for each account", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    store.setAccount("user_one");
    await store.rememberProject({ name: "First", directory: "/films/first" });
    store.setAccount("user_two");
    await store.rememberProject({ name: "Second", directory: "/films/second" });

    const restored = new DesktopAppStateStore(path);
    await restored.load();
    restored.setAccount("user_one");
    expect(restored.snapshot().recentProjects).toEqual([
      { name: "First", directory: "/films/first" },
    ]);
    restored.setAccount("user_two");
    expect(restored.snapshot().recentProjects).toEqual([
      { name: "Second", directory: "/films/second" },
    ]);
    expect(await readFile(path, "utf8")).not.toContain("timestamp");
  });

  it("starts empty without an account and rejects unsigned mutations", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    expect(store.snapshot().recentProjects).toEqual([]);
    await expect(
      store.rememberProject({ name: "First", directory: "/films/first" }),
    ).rejects.toThrow("Sign in");
  });

  it("does not migrate anonymous pre-account state", async () => {
    const { path } = await stateFixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        recentProjects: [{ name: "Legacy", directory: "/films/legacy" }],
      }),
    );
    const store = new DesktopAppStateStore(path);
    await store.load();
    store.setAccount("user_one");
    expect(store.snapshot().recentProjects).toEqual([]);
  });

  it("forgets an account project and its device-specific UI preferences", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    store.setAccount("user_one");
    await store.rememberProject({ name: "First", directory: "/films/first" });
    await store.setMediaPoolOpen("/films/first", false);
    await store.setInspectorOpen("/films/first", false);
    await store.setNotesOpen("/films/first", false);
    await store.setEditorLayout("/films/first", {
      mediaPoolWidth: 300,
      inspectorWidth: 300,
      notesWidth: 300,
      timelineHeight: 300,
    });

    await store.forgetProject("/films/first");
    expect(store.snapshot()).toEqual({
      version: 1,
      recentProjects: [],
      mediaPoolOpenByProject: {},
      inspectorOpenByProject: {},
      notesOpenByProject: {},
      editorLayoutsByProject: {},
    });
  });
});

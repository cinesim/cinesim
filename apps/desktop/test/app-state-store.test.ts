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
  it("starts empty and persists recent projects without timestamp churn", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    expect(store.snapshot()).toEqual({
      version: 1,
      recentProjects: [],
      mediaPoolOpenByProject: {},
      inspectorOpenByProject: {},
      notesOpenByProject: {},
      editorLayoutsByProject: {},
    });

    await store.rememberProject({ name: "First", directory: "/films/first" });
    await store.rememberProject({ name: "Second", directory: "/films/second" });
    await store.rememberProject({ name: "First renamed", directory: "/films/first" });

    expect(store.snapshot().recentProjects).toEqual([
      { name: "First renamed", directory: "/films/first" },
      { name: "Second", directory: "/films/second" },
    ]);
    expect(await readFile(path, "utf8")).not.toContain("timestamp");
  });

  it("recovers from invalid app state instead of affecting project data", async () => {
    const { path } = await stateFixture();
    await writeFile(path, "not json", "utf8");
    const store = new DesktopAppStateStore(path);
    await store.load();
    expect(store.snapshot()).toEqual({
      version: 1,
      recentProjects: [],
      mediaPoolOpenByProject: {},
      inspectorOpenByProject: {},
      notesOpenByProject: {},
      editorLayoutsByProject: {},
    });
  });

  it("does not restore legacy timeline tab state", async () => {
    const { path } = await stateFixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        recentProjects: [{ name: "First", directory: "/films/first" }],
        projectViews: {
          "/films/first": {
            openSequenceIds: ["sequence_1"],
            activeTab: "sequence_1",
          },
        },
      }),
      "utf8",
    );

    const store = new DesktopAppStateStore(path);
    await store.load();
    expect(store.snapshot()).toEqual({
      version: 1,
      recentProjects: [{ name: "First", directory: "/films/first" }],
      mediaPoolOpenByProject: {},
      inspectorOpenByProject: {},
      notesOpenByProject: {},
      editorLayoutsByProject: {},
    });
  });

  it("persists the Media Pool state per project", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    await store.setMediaPoolOpen("/films/first", false);
    await store.setMediaPoolOpen("/films/second", true);

    const restored = new DesktopAppStateStore(path);
    await restored.load();
    expect(restored.snapshot().mediaPoolOpenByProject).toEqual({
      "/films/first": false,
      "/films/second": true,
    });
  });

  it("forgets a project and all directory-scoped UI preferences", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
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

  it("persists the Inspector state per project", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    await store.setInspectorOpen("/films/first", false);
    await store.setInspectorOpen("/films/second", true);

    const restored = new DesktopAppStateStore(path);
    await restored.load();
    expect(restored.snapshot().inspectorOpenByProject).toEqual({
      "/films/first": false,
      "/films/second": true,
    });
  });

  it("persists the Notes state per project", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    await store.setNotesOpen("/films/first", false);
    await store.setNotesOpen("/films/second", true);

    const restored = new DesktopAppStateStore(path);
    await restored.load();
    expect(restored.snapshot().notesOpenByProject).toEqual({
      "/films/first": false,
      "/films/second": true,
    });
  });

  it("persists editor panel sizes per project", async () => {
    const { path } = await stateFixture();
    const store = new DesktopAppStateStore(path);
    await store.load();
    await store.setEditorLayout("/films/first", {
      mediaPoolWidth: 310,
      inspectorWidth: 295,
      notesWidth: 330,
      timelineHeight: 360,
    });

    const restored = new DesktopAppStateStore(path);
    await restored.load();
    expect(restored.snapshot().editorLayoutsByProject).toEqual({
      "/films/first": {
        mediaPoolWidth: 310,
        inspectorWidth: 295,
        notesWidth: 330,
        timelineHeight: 360,
      },
    });
  });

  it("ignores invalid persisted editor layouts", async () => {
    const { path } = await stateFixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        recentProjects: [],
        mediaPoolOpenByProject: {},
        inspectorOpenByProject: {},
        notesOpenByProject: {},
        editorLayoutsByProject: {
          "/films/valid": {
            mediaPoolWidth: 280,
            inspectorWidth: 300,
            timelineHeight: 320,
          },
          "/films/invalid": {
            mediaPoolWidth: -1,
            inspectorWidth: 300,
            timelineHeight: 320,
          },
        },
      }),
      "utf8",
    );

    const store = new DesktopAppStateStore(path);
    await store.load();
    expect(store.snapshot().editorLayoutsByProject).toEqual({
      "/films/valid": {
        mediaPoolWidth: 280,
        inspectorWidth: 300,
        notesWidth: 300,
        timelineHeight: 320,
      },
    });
  });
});

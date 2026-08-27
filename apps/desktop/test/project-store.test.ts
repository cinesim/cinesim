import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopProjectStore } from "../src/main/projects/project-store";
import { canonicalProjectSizeBytes } from "../src/main/projects/project-size";

const temporaryDirectories: string[] = [];

function createSilentWave(durationSeconds = 1, sampleRate = 8_000): Uint8Array {
  const sampleCount = durationSeconds * sampleRate;
  const dataLength = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      bytes[offset + index] = value.charCodeAt(index);
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);
  return bytes;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("DesktopProjectStore", () => {
  it("creates an account-registered canonical project", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-account-project-test-"));
    temporaryDirectories.push(parentDirectory);
    const store = new DesktopProjectStore();
    const session = await store.create(parentDirectory, {
      name: "Account fixture",
      projectId: "project_fixture_unique",
      cloudProjectId: "cloud_project_fixture0000001",
    });

    expect(session.project).toMatchObject({
      id: "project_fixture_unique",
      cloudProjectId: "cloud_project_fixture0000001",
      name: "Account fixture",
    });
    const reopened = new DesktopProjectStore();
    await expect(reopened.open(session.directory)).resolves.toMatchObject({
      project: {
        id: "project_fixture_unique",
        cloudProjectId: "cloud_project_fixture0000001",
      },
    });
  });

  it("measures canonical project files without counting disposable video output", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-size-test-"));
    temporaryDirectories.push(parentDirectory);
    const store = new DesktopProjectStore();
    const session = await store.create(parentDirectory, "Size fixture");

    const canonicalSize = await canonicalProjectSizeBytes(session.directory);
    await writeFile(
      join(session.directory, ".video", "cache", "preview.bin"),
      new Uint8Array(1024),
    );

    expect(canonicalSize).toBeGreaterThan(0);
    await expect(canonicalProjectSizeBytes(session.directory)).resolves.toBe(canonicalSize);
  });

  it("inspects a filesystem-backed audio file through Mediabunny", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-import-test-"));
    temporaryDirectories.push(parentDirectory);
    const mediaPath = join(parentDirectory, "tone.wav");
    await writeFile(mediaPath, createSilentWave());

    const store = new DesktopProjectStore();
    await store.create(parentDirectory, "Import fixture");
    const session = await store.inspectAndImportMedia(mediaPath);

    expect(session.project.assets).toHaveLength(1);
    expect(session.project.assets[0]).toMatchObject({
      kind: "audio",
      name: "tone.wav",
      source: { kind: "local", path: mediaPath },
      durationUs: 1_000_000,
      hasAudio: true,
    });
  });

  it("serializes concurrent canonical writes through one desktop writer", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-writer-test-"));
    temporaryDirectories.push(parentDirectory);
    const store = new DesktopProjectStore();
    const created = await store.create(parentDirectory, "Writer fixture");

    await Promise.all([
      store.execute({
        type: "asset.import",
        asset: {
          id: "asset_first",
          kind: "audio",
          name: "First",
          source: { kind: "local", path: join(parentDirectory, "first.wav") },
          durationUs: 1_000_000,
          hasAudio: true,
        },
      }),
      store.execute({
        type: "asset.import",
        asset: {
          id: "asset_second",
          kind: "audio",
          name: "Second",
          source: { kind: "local", path: join(parentDirectory, "second.wav") },
          durationUs: 1_000_000,
          hasAudio: true,
        },
      }),
    ]);

    const reloaded = new DesktopProjectStore();
    const session = await reloaded.open(created.directory);
    expect(session.project.assets.map((asset) => asset.id)).toEqual([
      "asset_first",
      "asset_second",
    ]);
  });

  it("persists timeline creation and cascading asset removal through commands", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-delete-test-"));
    temporaryDirectories.push(parentDirectory);
    const store = new DesktopProjectStore();
    const created = await store.create(parentDirectory, "Delete fixture");
    await store.execute({
      type: "asset.import",
      asset: {
        id: "asset_selected",
        kind: "audio",
        name: "Selected",
        source: { kind: "local", path: join(parentDirectory, "selected.wav") },
        durationUs: 1_000_000,
      },
    });
    await store.execute({
      type: "sequence.createFromAssets",
      assetIds: ["asset_selected"],
      name: "Selects",
    });
    await store.execute({ type: "asset.remove", assetIds: ["asset_selected"] });

    const reopened = new DesktopProjectStore();
    const session = await reopened.open(created.directory);
    expect(session.project.assets).toEqual([]);
    expect(session.project.sequences).toHaveLength(2);
    expect(
      session.project.sequences
        .flatMap((sequence) => sequence.tracks)
        .every((track) => track.clips.length === 0),
    ).toBe(true);
  });

  it("closes the active project and its derived scope", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-close-test-"));
    temporaryDirectories.push(parentDirectory);
    const store = new DesktopProjectStore();
    await store.create(parentDirectory, "Close fixture");

    await store.close();

    expect(store.directory).toBeNull();
    expect(store.project).toBeNull();
    expect(() => store.session()).toThrow("No project is open");
  });
});

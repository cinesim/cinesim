import { timeUs } from "@cinesim/core";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DesktopProjectStore } from "../src/main/projects/project-store";
import { canonicalProjectSizeBytes } from "../src/main/projects/project-size";
import { inferCodecBitDepth, isTemporaryMediaSelection } from "../src/main/projects/media-import";

const temporaryDirectories: string[] = [];
const projectStores: DesktopProjectStore[] = [];

function createProjectStore(): DesktopProjectStore {
  const store = new DesktopProjectStore();
  projectStores.push(store);
  return store;
}

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
  for (const store of projectStores.splice(0)) await store.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("DesktopProjectStore", () => {
  it("uses one managed guidance block and regenerates project custom instructions", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-guidance-test-"));
    temporaryDirectories.push(parentDirectory);
    let defaultInstructions = "Keep interview pauses.";
    const store = createProjectStore();
    store.setDefaultAgentInstructions(() => defaultInstructions);
    const created = await store.create(parentDirectory, "Guidance fixture");

    await expect(store.agentGuidance()).resolves.toMatchObject({
      defaultCustomInstructions: "Keep interview pauses.",
      projectCustomInstructions: "Keep interview pauses.",
    });
    await store.updateAgentGuidance("Prefer direct cuts.");
    await expect(readFile(join(created.directory, "AGENTS.md"), "utf8")).resolves.toContain(
      "Prefer direct cuts.",
    );

    defaultInstructions = "Use the team default.";
    await store.updateAgentGuidance(defaultInstructions);
    await expect(store.agentGuidance()).resolves.toMatchObject({
      defaultCustomInstructions: "Use the team default.",
      projectCustomInstructions: "Use the team default.",
    });

    await rm(join(created.directory, "AGENTS.md"));
    await store.close();
    const reopened = createProjectStore();
    reopened.setDefaultAgentInstructions(() => defaultInstructions);
    await reopened.open(created.directory);
    await expect(readFile(join(created.directory, "AGENTS.md"), "utf8")).resolves.toContain(
      "Use the team default.",
    );
  });

  it("creates immutable local and cloud project kinds", async () => {
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

    const local = new DesktopProjectStore();
    const localSession = await local.create(parentDirectory, {
      name: "Local fixture",
      projectId: "project_local_fixture",
    });
    expect(localSession.project.cloudProjectId).toBeUndefined();
  });

  it("creates a numbered sibling without touching an existing project folder", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-project-collision-test-"));
    temporaryDirectories.push(parentDirectory);
    const existingDirectory = join(parentDirectory, "test-proj");
    await mkdir(existingDirectory);
    const markerPath = join(existingDirectory, "keep.txt");
    await writeFile(markerPath, "existing project");

    const store = new DesktopProjectStore();
    const session = await store.create(parentDirectory, {
      name: "Test Proj",
      projectId: "project_collision_fixture",
      cloudProjectId: "cloud_project_collision00001",
    });

    expect(session.directory).toBe(join(parentDirectory, "test-proj-2"));
    await expect(readFile(markerPath, "utf8")).resolves.toBe("existing project");
    expect(session.project.cloudProjectId).toBe("cloud_project_collision00001");
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
      durationUs: timeUs(1_000_000),
      hasAudio: true,
      technical: {
        containerMimeType: "audio/wav",
        durationSeconds: 1,
        compatibility: "supported",
        audio: {
          codec: "pcm-s16",
          decoderAvailability: "supported",
          sampleRate: 8_000,
          channels: 1,
          channelLayout: "mono",
        },
      },
    });
  });

  it("extracts bit depth only from codec parameter formats that carry it", () => {
    expect(inferCodecBitDepth("vp09.02.10.10.01")).toBe(10);
    expect(inferCodecBitDepth("av01.0.08M.08.0.110.01.01.01.0")).toBe(8);
    expect(inferCodecBitDepth("avc1.640028")).toBeUndefined();
  });

  it("copies temporary picker media into disposable originals without modifying the source", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-managed-import-test-"));
    temporaryDirectories.push(parentDirectory);
    const mediaPath = join(parentDirectory, "photos-tone.wav");
    const mediaBytes = createSilentWave();
    await writeFile(mediaPath, mediaBytes);

    const store = new DesktopProjectStore();
    const created = await store.create(parentDirectory, "Managed import fixture");
    const session = await store.inspectAndImportMedia(mediaPath, { managedCopy: true });

    const asset = session.project.assets[0]!;
    expect(asset.name).toBe("photos-tone.wav");
    expect(asset.source).toEqual({
      kind: "local",
      path: join(created.directory, ".video", "originals", asset.id),
    });
    await expect(readFile(mediaPath)).resolves.toEqual(Buffer.from(mediaBytes));
    await expect(readFile((asset.source as { path: string }).path)).resolves.toEqual(
      Buffer.from(mediaBytes),
    );
  });

  it("recognizes only macOS temporary-directory media as temporary picker output", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cinesim-picker-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "cinesim-picker-outside-"));
    temporaryDirectories.push(temporaryRoot, outsideRoot);
    const nested = join(temporaryRoot, "com.apple.Photos");
    await mkdir(nested);
    const photosPath = join(nested, "export.mov");
    const outsidePath = join(outsideRoot, "source.mov");
    await Promise.all([writeFile(photosPath, "photos"), writeFile(outsidePath, "outside")]);

    await expect(
      isTemporaryMediaSelection(photosPath, {
        platform: "darwin",
        temporaryDirectory: temporaryRoot,
      }),
    ).resolves.toBe(true);
    await expect(
      isTemporaryMediaSelection(outsidePath, {
        platform: "darwin",
        temporaryDirectory: temporaryRoot,
      }),
    ).resolves.toBe(false);
    await expect(
      isTemporaryMediaSelection(photosPath, {
        platform: "linux",
        temporaryDirectory: temporaryRoot,
      }),
    ).resolves.toBe(false);
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
          durationUs: timeUs(1_000_000),
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
          durationUs: timeUs(1_000_000),
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

  it("rejects a stale desktop writer without changing its live session", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-stale-writer-test-"));
    temporaryDirectories.push(parentDirectory);
    const creator = createProjectStore();
    const created = await creator.create(parentDirectory, "Stale writer fixture");
    const first = createProjectStore();
    const stale = createProjectStore();
    await Promise.all([first.open(created.directory), stale.open(created.directory)]);
    const asset = {
      id: "asset_first_writer" as const,
      kind: "audio" as const,
      name: "First writer",
      source: { kind: "local" as const, path: join(parentDirectory, "first.wav") },
      durationUs: timeUs(1_000_000),
    };
    await first.execute({ type: "asset.import", asset });

    await expect(
      stale.execute({
        type: "asset.import",
        asset: { ...asset, id: "asset_stale_writer", name: "Stale writer" },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_PROJECT_CONFLICT" });
    expect(stale.project?.assets).toEqual([]);
    const reopened = createProjectStore();
    await expect(reopened.open(created.directory)).resolves.toMatchObject({
      project: { assets: [expect.objectContaining({ id: "asset_first_writer" })] },
    });
  });

  it("rejects a project whose derived layout redirects through a symlink", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "cinesim-symlink-layout-test-"));
    temporaryDirectories.push(parentDirectory);
    const store = new DesktopProjectStore();
    const created = await store.create(parentDirectory, "Symlink fixture");
    const outside = join(parentDirectory, "outside");
    await mkdir(outside);
    await rm(join(created.directory, ".video", "thumbnails"), { recursive: true });
    await symlink(outside, join(created.directory, ".video", "thumbnails"));

    await expect(new DesktopProjectStore().open(created.directory)).rejects.toThrow(
      "Project directory component is unsafe",
    );
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
        durationUs: timeUs(1_000_000),
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

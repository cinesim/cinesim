import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProject,
  DEFAULT_SETTINGS,
  DEFAULT_TRANSFORM,
  timeUs,
  type Project,
} from "@cinesim/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  checkV1Migration,
  detectProjectFormat,
  migrateV1Project,
  SourceProjectRepository,
} from "../src";
import { CanonicalProjectRepository } from "../src/canonical-repository";

const parents: string[] = [];

async function projectDirectory(name = "project with space α"): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "cinesim-migration-"));
  parents.push(parent);
  const directory = join(parent, name);
  await mkdir(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true })));
});

function fixture(): Project {
  const project = createProject({
    id: "project_fixture",
    cloudProjectId: "cloud_project_abcdefgh",
    name: "Documentary α",
    width: 3840,
    height: 2160,
    frameRate: 23.976,
  });
  project.assets.push({
    id: "asset_camera",
    kind: "video",
    name: "Camera A",
    source: { kind: "cloud", cloudAssetId: "cloud_asset_abcdefgh" },
    durationUs: timeUs(20_000_000),
    width: 3840,
    height: 2160,
    frameRate: 23.976,
    hasAudio: true,
  });
  const [video, audio] = project.sequences[0]!.tracks;
  video!.muted = true;
  audio!.locked = true;
  video!.clips.push({
    id: "clip_video",
    assetId: "asset_camera",
    mediaKind: "video",
    linkedClipId: "clip_audio",
    timelineStartUs: timeUs(1_234_567),
    sourceStartUs: timeUs(2_345_678),
    sourceEndUs: timeUs(8_765_432),
    fadeInUs: timeUs(111_111),
    fadeOutUs: timeUs(222_222),
    transform: {
      ...DEFAULT_TRANSFORM,
      x: 12.5,
      y: -20,
      scaleX: 1.25,
      scaleY: 0.75,
      opacity: 0.8,
      fit: "cover",
    },
  });
  audio!.clips.push({
    id: "clip_audio",
    assetId: "asset_camera",
    mediaKind: "audio",
    linkedClipId: "clip_video",
    timelineStartUs: timeUs(1_234_567),
    sourceStartUs: timeUs(2_345_678),
    sourceEndUs: timeUs(8_765_432),
    fadeInUs: timeUs(111_111),
    fadeOutUs: timeUs(222_222),
    transform: DEFAULT_TRANSFORM,
  });
  project.sequences.push({
    id: "sequence_selects",
    name: "Selects",
    width: 1920,
    height: 1080,
    frameRate: 30,
    tracks: [
      {
        id: "track_selects",
        name: "Selects",
        kind: "video",
        muted: false,
        locked: false,
        clips: [],
      },
    ],
  });
  return project;
}

async function writeV1(directory: string, project = fixture()): Promise<void> {
  const repository = await CanonicalProjectRepository.open(directory);
  await repository.commit({ project, settings: DEFAULT_SETTINGS, expectedGeneration: null });
  await writeFile(join(directory, "AGENTS.md"), "legacy instructions\n");
  await writeFile(join(directory, ".gitignore"), ".video/\n");
}

describe("format-v1 to format-v2 migration", () => {
  it("checks without writing, backs up, preserves semantics/ids, and is idempotent", async () => {
    const directory = await projectDirectory();
    await writeV1(directory);
    const plan = await checkV1Migration(directory);
    expect(plan).toMatchObject({
      detected: "v1",
      entry: "main.jsx",
      issues: [],
      summary: { compositions: 2, tracks: 3, clips: 2, assets: 1 },
    });
    await expect(access(join(directory, "cinesim.toml"))).rejects.toMatchObject({ code: "ENOENT" });

    const migrated = await migrateV1Project(directory);
    expect(migrated.migrated).toBe(true);
    expect(migrated.preservedIds).toEqual(
      expect.arrayContaining([
        "project_fixture",
        "asset_camera",
        "sequence_selects",
        "clip_video",
        "clip_audio",
      ]),
    );
    expect(await detectProjectFormat(directory)).toBe("v2");
    await expect(access(join(directory, "cinesim.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(directory, ".cinesim"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(directory, "main.jsx"), "utf8")).resolves.toContain(
      "microseconds(1234567)",
    );
    await expect(
      readFile(join(migrated.backupDirectory!, "cinesim.json"), "utf8"),
    ).resolves.toContain('"version": 1');
    const reopened = await (await SourceProjectRepository.open(directory)).load();
    expect(reopened.compilation.ir.compositions).toHaveLength(2);
    expect(reopened.compilation.ir.compositions[0]!.timeline.tracks[0]!.clips[0]).toMatchObject({
      id: "clip_video",
      timelineStartUs: 1_234_567,
      sourceStartUs: 2_345_678,
      durationUs: 6_419_754,
    });

    const second = await migrateV1Project(directory);
    expect(second).toMatchObject({ detected: "v2", migrated: false });
  });

  it("chooses a deterministic non-conflicting entry and produces byte-identical output", async () => {
    const first = await projectDirectory("first");
    const second = await projectDirectory("second");
    await Promise.all([writeV1(first), writeV1(second)]);
    await Promise.all([
      writeFile(join(first, "main.jsx"), "user source\n"),
      writeFile(join(second, "main.jsx"), "user source\n"),
    ]);
    const [firstResult, secondResult] = await Promise.all([
      migrateV1Project(first),
      migrateV1Project(second),
    ]);
    expect(firstResult.entry).toBe("cinesim-main.jsx");
    expect(secondResult.entry).toBe("cinesim-main.jsx");
    const [firstManifest, secondManifest, firstSource, secondSource] = await Promise.all([
      readFile(join(first, "cinesim.toml"), "utf8"),
      readFile(join(second, "cinesim.toml"), "utf8"),
      readFile(join(first, "cinesim-main.jsx"), "utf8"),
      readFile(join(second, "cinesim-main.jsx"), "utf8"),
    ]);
    expect(firstManifest).toBe(secondManifest);
    expect(firstSource).toBe(secondSource);
    await expect(readFile(join(first, "main.jsx"), "utf8")).resolves.toBe("user source\n");
  });

  it("migrates an empty project", async () => {
    const directory = await projectDirectory("empty");
    await writeV1(directory, createProject({ id: "project_empty", name: "Empty" }));
    await expect(migrateV1Project(directory)).resolves.toMatchObject({
      migrated: true,
      summary: { clips: 0, assets: 0 },
    });
  });
});

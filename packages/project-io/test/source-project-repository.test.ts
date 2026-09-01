import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, timeUs } from "@cinesim/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  parseAssetManifest,
  parseProjectManifest,
  patchAssetManifestAdd,
  patchAssetManifestRemove,
  patchAssetManifestSource,
  patchManifestSetting,
  nodeProjectFileSystem,
  serializeAssetManifest,
  serializeProjectManifest,
  sourceRevision,
  SourceProjectConflictError,
  SourceProjectRepository,
  StaleSourceRevisionError,
  UnsafeProjectPathError,
  type ProjectManifest,
  type ProjectFileSystem,
} from "../src";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-project-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const asset = {
  id: "asset_camera" as const,
  kind: "video" as const,
  name: "Camera α",
  source: { kind: "local" as const, path: "/Volumes/Footage with spaces/α.mov" },
  durationUs: timeUs(12_000_000),
  width: 3840,
  height: 2160,
  frameRate: 23.976,
  hasAudio: true,
  inputColor: { policy: "source-metadata" as const },
  technical: {
    containerMimeType: 'video/quicktime; codecs="hvc1,mp4a.40.2"',
    durationSeconds: 12,
    compatibility: "supported" as const,
    video: {
      codec: "hevc",
      codecParameters: "hvc1.2.4.L153.B0",
      internalCodecId: "hvc1",
      decoderAvailability: "supported" as const,
      codedWidth: 3840,
      codedHeight: 2160,
      displayWidth: 3840,
      displayHeight: 2160,
      rotationDegrees: 0,
      pixelAspectRatio: { numerator: 1, denominator: 1 },
      frameRate: {
        mode: "constant" as const,
        nominal: 23.976,
        minimum: 23.976,
        maximum: 23.976,
        average: 23.976,
        probedFrames: 256,
      },
      color: {
        primaries: "bt2020",
        transfer: "hlg",
        matrix: "bt2020-ncl",
        fullRange: false,
        bitDepth: 10,
        hdr: true,
        uncertain: false,
      },
    },
    audio: {
      codec: "aac",
      codecParameters: "mp4a.40.2",
      internalCodecId: "mp4a",
      decoderAvailability: "supported" as const,
      sampleRate: 48_000,
      channels: 2,
      channelLayout: "stereo",
    },
  },
};

function emptyManifest(): ProjectManifest {
  return {
    formatVersion: 3,
    languageVersion: 1,
    project: {
      id: "project_test",
      name: "Test",
      entry: "main.jsx",
      activeCompositionId: "sequence_main",
    },
    settings: DEFAULT_SETTINGS,
  };
}

function withSourcePublishFailure(directory: string, failAt: number): ProjectFileSystem {
  const canonicalTargets = new Set([
    join(directory, "cinesim.toml"),
    join(directory, "assets.toml"),
    join(directory, "main.jsx"),
  ]);
  let publishes = 0;
  return {
    ...nodeProjectFileSystem,
    async rename(...arguments_: Parameters<ProjectFileSystem["rename"]>) {
      const [source, destination] = arguments_.map(String);
      if (canonicalTargets.has(destination!) && source!.includes(".cinesim-source-tx-")) {
        publishes += 1;
        if (publishes === failAt) throw new Error(`injected source publish failure ${failAt}`);
      }
      await nodeProjectFileSystem.rename(...arguments_);
    },
  };
}

describe("project manifest", () => {
  it("rejects obsolete format-two projects with a precise split-manifest error", () => {
    expect(() => parseProjectManifest("format_version = 2\nlanguage_version = 1\n")).toThrow(
      /requires format 3 with a separate assets\.toml file/u,
    );
  });

  it("serializes deterministically and preserves comments/unknown tables during targeted edits", () => {
    const initial = `${serializeProjectManifest(emptyManifest())}\n# user note\n[user.custom]\nkeep = "yes"\n`;
    const withSetting = patchManifestSetting(
      initial,
      "previewQuality",
      "quarter",
      sourceRevision(initial),
    );
    expect(withSetting).toContain("# user note");
    expect(withSetting).toContain('[user.custom]\nkeep = "yes"');
    const emptyAssets = serializeAssetManifest({ formatVersion: 1, assets: [] });
    const withAsset = patchAssetManifestAdd(emptyAssets, asset, sourceRevision(emptyAssets));
    expect(parseAssetManifest(withAsset).assets).toEqual([asset]);
    expect(withAsset).toContain("/Volumes/Footage with spaces/α.mov");
    const relinked = patchAssetManifestSource(
      withAsset,
      asset.id,
      { kind: "cloud", cloudAssetId: "cloud_asset_abcdefgh" },
      sourceRevision(withAsset),
    );
    expect(parseAssetManifest(relinked).assets[0]!.source).toEqual({
      kind: "cloud",
      cloudAssetId: "cloud_asset_abcdefgh",
    });
    const removed = patchAssetManifestRemove(relinked, asset.id, sourceRevision(relinked));
    expect(parseAssetManifest(removed).assets).toEqual([]);
    expect(withSetting).toContain("# user note");
    expect(() => patchManifestSetting(initial, "autosave", false, "stale")).toThrow(
      StaleSourceRevisionError,
    );
  });
});

describe("SourceProjectRepository", () => {
  it("creates canonical source files, compiles, imports an asset, and reopens deterministically", async () => {
    const directory = await temporaryDirectory();
    const created = await SourceProjectRepository.create(directory, {
      id: "project_test",
      name: "Source project",
    });
    expect(created.compilation.ir.activeCompositionId).toBe("sequence_main");
    await expect(readFile(join(directory, "cinesim.toml"), "utf8")).resolves.toContain(
      "format_version = 3",
    );
    await expect(readFile(join(directory, "assets.toml"), "utf8")).resolves.toContain(
      "format_version = 1",
    );
    await expect(readFile(join(directory, "main.jsx"), "utf8")).resolves.toContain("<timeline");
    await expect(readFile(join(directory, "AGENTS.md"), "utf8")).resolves.toContain(
      "Canonical state is `cinesim.toml`",
    );
    await expect(readFile(join(directory, "CLAUDE.md"), "utf8")).resolves.toBe("@AGENTS.md\n");
    await expect(readFile(join(directory, ".mcp.json"), "utf8")).resolves.toContain(
      '"command": "cinesim"',
    );
    await expect(readFile(join(directory, ".codex/config.toml"), "utf8")).resolves.toContain(
      "[mcp_servers.cinesim]",
    );
    await expect(readFile(join(directory, ".gitignore"), "utf8")).resolves.toBe(".video/\n");
    const repository = await SourceProjectRepository.open(directory);
    const imported = await repository.importAsset(asset, created.generation);
    expect(imported.assets[0]).toEqual(asset);
    const reopened = await repository.load();
    expect(reopened.generation).toBe(imported.generation);
    expect(reopened.manifestSource).toBe(imported.manifestSource);
  });

  it("rejects stale writers and source modules that escape through symlinks", async () => {
    const directory = await temporaryDirectory();
    const initial = await SourceProjectRepository.create(directory, {
      id: "project_test",
      name: "Source project",
    });
    const repository = await SourceProjectRepository.open(directory);
    const updated = await repository.updateSetting("autosave", false, initial.generation);
    await expect(
      repository.updateSetting("autosave", true, initial.generation),
    ).rejects.toBeInstanceOf(SourceProjectConflictError);
    expect(updated.manifest.settings.autosave).toBe(false);

    const outside = await temporaryDirectory();
    await writeFile(
      join(outside, "Outside.jsx"),
      'export function Outside() { return <rect id="outside" />; }',
    );
    await symlink(join(outside, "Outside.jsx"), join(directory, "Outside.jsx"));
    const source = `import { Outside } from "./Outside.jsx";
export const main = <composition id="sequence_main" width={1920} height={1080} fps={30}><timeline id="timeline_main"><track id="track_overlay" kind="overlay" name="Overlay"><clip id="clip_scene" start={seconds(0)} duration={seconds(1)}><Outside id="bad" /></clip></track></timeline></composition>;
export default main;
`;
    await expect(
      repository.commit({
        expectedGeneration: updated.generation,
        sources: { "main.jsx": source },
      }),
    ).rejects.toBeInstanceOf(UnsafeProjectPathError);
  });

  it("refuses creation conflicts without overwriting user files", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, ".video"));
    await writeFile(join(directory, "main.jsx"), "user file");
    await expect(
      SourceProjectRepository.create(directory, { id: "project_test", name: "Conflict" }),
    ).rejects.toThrow(/Refusing to overwrite/);
    await expect(readFile(join(directory, "main.jsx"), "utf8")).resolves.toBe("user file");
  });

  it("rolls back a partially published multi-file source transaction", async () => {
    for (const failAt of [1, 2]) {
      const directory = await temporaryDirectory();
      const initial = await SourceProjectRepository.create(directory, {
        id: `project_rollback_${failAt}`,
        name: "Rollback",
      });
      const repository = await SourceProjectRepository.open(
        directory,
        withSourcePublishFailure(directory, failAt),
      );
      const manifestSource = patchManifestSetting(
        initial.manifestSource,
        "autosave",
        false,
        sourceRevision(initial.manifestSource),
      );
      await expect(
        repository.commit({
          expectedGeneration: initial.generation,
          manifestSource,
          sources: { "main.jsx": `${initial.sources["main.jsx"]!}\n` },
        }),
      ).rejects.toThrow(`injected source publish failure ${failAt}`);

      const recovered = await (await SourceProjectRepository.open(directory)).load();
      expect(recovered.generation).toBe(initial.generation);
      expect(recovered.manifestSource).toBe(initial.manifestSource);
      expect(recovered.sources["main.jsx"]).toBe(initial.sources["main.jsx"]);
    }
  });
});

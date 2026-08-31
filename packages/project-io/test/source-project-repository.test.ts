import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeUs } from "@cinesim/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  parseProjectManifest,
  patchManifestAddAsset,
  patchManifestAssetSource,
  patchManifestRemoveAsset,
  patchManifestSetting,
  nodeProjectFileSystem,
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
};

function emptyManifest(): ProjectManifest {
  return {
    formatVersion: 2,
    languageVersion: 1,
    project: {
      id: "project_test",
      name: "Test",
      entry: "main.jsx",
      activeCompositionId: "sequence_main",
    },
    settings: {
      version: 1,
      autosave: true,
      previewQuality: "half",
      backgroundColor: "#09090b",
      defaultFilmstripIntervalSeconds: 5,
      proxyGeneration: "automatic",
      proxyProfile: "balanced",
      proxyMaxLongEdge: 1280,
      proxyFrameRateCap: 60,
      proxyQuality: "medium",
    },
    compiler: { strict: true },
    assets: [],
  };
}

function withSourcePublishFailure(directory: string, failAt: number): ProjectFileSystem {
  const canonicalTargets = new Set([join(directory, "cinesim.toml"), join(directory, "main.jsx")]);
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
  it("serializes deterministically and preserves comments/unknown tables during targeted edits", () => {
    const initial = `${serializeProjectManifest(emptyManifest())}\n# user note\n[user.custom]\nkeep = "yes"\n`;
    const withSetting = patchManifestSetting(
      initial,
      "preview_quality",
      "quarter",
      sourceRevision(initial),
    );
    expect(withSetting).toContain("# user note");
    expect(withSetting).toContain('[user.custom]\nkeep = "yes"');
    const withAsset = patchManifestAddAsset(withSetting, asset, sourceRevision(withSetting));
    expect(parseProjectManifest(withAsset).assets).toEqual([asset]);
    expect(withAsset).toContain("/Volumes/Footage with spaces/α.mov");
    const relinked = patchManifestAssetSource(
      withAsset,
      asset.id,
      { kind: "cloud", cloudAssetId: "cloud_asset_abcdefgh" },
      sourceRevision(withAsset),
    );
    expect(parseProjectManifest(relinked).assets[0]!.source).toEqual({
      kind: "cloud",
      cloudAssetId: "cloud_asset_abcdefgh",
    });
    const removed = patchManifestRemoveAsset(relinked, asset.id, sourceRevision(relinked));
    expect(parseProjectManifest(removed).assets).toEqual([]);
    expect(removed).toContain("# user note");
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
      "format_version = 2",
    );
    await expect(readFile(join(directory, "main.jsx"), "utf8")).resolves.toContain("<timeline");
    await expect(readFile(join(directory, "AGENTS.md"), "utf8")).resolves.toContain(
      "Canonical state is `cinesim.toml`",
    );
    await expect(readFile(join(directory, ".gitignore"), "utf8")).resolves.toBe(".video/\n");
    await expect(readFile(join(directory, "cinesim.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const repository = await SourceProjectRepository.open(directory);
    const imported = await repository.importAsset(asset, created.generation);
    expect(imported.manifest.assets[0]).toEqual(asset);
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

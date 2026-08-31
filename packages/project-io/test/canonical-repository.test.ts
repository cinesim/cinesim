import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeUs, createProject, DEFAULT_SETTINGS, PROJECT_FILES } from "@cinesim/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { nodeProjectFileSystem, ProjectPaths, UnsafeProjectPathError } from "../src";
import {
  CanonicalProjectRepository,
  CanonicalWriteConflictError,
} from "../src/canonical-repository";
import type { ProjectFileSystem, ProjectFileHandle } from "../src";

const temporaryDirectories: string[] = [];

async function temporaryProjectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-project-io-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRepository(name = "Initial") {
  const directory = await temporaryProjectDirectory();
  const repository = await CanonicalProjectRepository.open(directory);
  const project = createProject({ name });
  const generation = await repository.commit({
    project,
    settings: DEFAULT_SETTINGS,
    expectedGeneration: null,
  });
  return { directory, repository, project, generation };
}

function withWriteFailure(failAt: number): ProjectFileSystem {
  let writes = 0;
  return {
    ...nodeProjectFileSystem,
    async writeFile(...arguments_: Parameters<ProjectFileSystem["writeFile"]>) {
      writes += 1;
      if (writes === failAt) throw new Error(`injected write failure ${failAt}`);
      return nodeProjectFileSystem.writeFile(...arguments_);
    },
  } as ProjectFileSystem;
}

function withSyncFailure(failAt: number): ProjectFileSystem {
  let syncs = 0;
  return {
    ...nodeProjectFileSystem,
    async open(path: string, flags: string): Promise<ProjectFileHandle> {
      const handle = await nodeProjectFileSystem.open(path, flags);
      return {
        close: () => handle.close(),
        async sync() {
          syncs += 1;
          if (syncs === failAt) throw new Error(`injected sync failure ${failAt}`);
          await handle.sync();
        },
      };
    },
  };
}

function withPublishFailure(directory: string, failAt: number): ProjectFileSystem {
  const canonicalTargets = new Set(
    Object.values(PROJECT_FILES).map((path) => join(directory, path)),
  );
  let publishes = 0;
  return {
    ...nodeProjectFileSystem,
    async rename(...arguments_: Parameters<ProjectFileSystem["rename"]>) {
      const [source, destination] = arguments_.map(String);
      if (canonicalTargets.has(destination!) && source!.includes(".cinesim-tx-")) {
        publishes += 1;
        if (publishes === failAt) throw new Error(`injected publish failure ${failAt}`);
      }
      await nodeProjectFileSystem.rename(...arguments_);
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("CanonicalProjectRepository", () => {
  it("loads exactly the generation that was durably committed", async () => {
    const { repository, generation } = await createRepository("Durable fixture");

    await expect(repository.load()).resolves.toMatchObject({
      project: { name: "Durable fixture" },
      generation,
    });
  });

  it("rejects a stale writer instead of overwriting a newer generation", async () => {
    const { directory } = await createRepository();
    const first = await CanonicalProjectRepository.open(directory);
    const second = await CanonicalProjectRepository.open(directory);
    const firstSnapshot = await first.load();
    const secondSnapshot = await second.load();
    await first.commit({
      project: { ...firstSnapshot.project, name: "First writer" },
      settings: firstSnapshot.settings,
      expectedGeneration: firstSnapshot.generation,
    });

    await expect(
      second.commit({
        project: { ...secondSnapshot.project, name: "Stale writer" },
        settings: secondSnapshot.settings,
        expectedGeneration: secondSnapshot.generation,
      }),
    ).rejects.toBeInstanceOf(CanonicalWriteConflictError);
    await expect(first.load()).resolves.toMatchObject({ project: { name: "First writer" } });
  });

  it("leaves the prior generation intact when any staged write fails", async () => {
    for (const failAt of [2, 3, 4, 5, 6]) {
      const { directory, generation, project } = await createRepository();
      const repository = await CanonicalProjectRepository.open(directory, {
        fileSystem: withWriteFailure(failAt),
      });

      await expect(
        repository.commit({
          project: { ...project, name: `Failed ${failAt}` },
          settings: DEFAULT_SETTINGS,
          expectedGeneration: generation,
        }),
      ).rejects.toThrow(`injected write failure ${failAt}`);
      const recovered = await CanonicalProjectRepository.open(directory);
      await expect(recovered.load()).resolves.toMatchObject({
        project: { name: "Initial" },
        generation,
      });
    }
  });

  it("leaves the prior generation intact when staged data cannot be synchronized", async () => {
    for (const failAt of [1, 2, 3, 4, 5]) {
      const { directory, generation, project } = await createRepository();
      const repository = await CanonicalProjectRepository.open(directory, {
        fileSystem: withSyncFailure(failAt),
      });

      await expect(
        repository.commit({
          project: { ...project, name: `Unsynced ${failAt}` },
          settings: DEFAULT_SETTINGS,
          expectedGeneration: generation,
        }),
      ).rejects.toThrow(`injected sync failure ${failAt}`);
      const recovered = await CanonicalProjectRepository.open(directory);
      await expect(recovered.load()).resolves.toMatchObject({
        project: { name: "Initial" },
        generation,
      });
    }
  });

  it("rolls back every partially published canonical file", async () => {
    for (const failAt of [1, 2, 3, 4]) {
      const {
        directory,
        repository: initialRepository,
        generation,
        project,
      } = await createRepository();
      const changedProject = structuredClone(project);
      changedProject.name = `Partial ${failAt}`;
      changedProject.assets.push({
        id: `asset_partial_${failAt}`,
        kind: "audio",
        name: "Changed asset file",
        source: { kind: "local", path: join(directory, "source.wav") },
        durationUs: timeUs(1_000_000),
      });
      changedProject.sequences[0]!.name = "Changed timeline file";
      const repository = await CanonicalProjectRepository.open(directory, {
        fileSystem: withPublishFailure(initialRepository.paths.root, failAt),
      });

      await expect(
        repository.commit({
          project: changedProject,
          settings: { ...DEFAULT_SETTINGS, proxyQuality: "high" },
          expectedGeneration: generation,
        }),
      ).rejects.toThrow(`injected publish failure ${failAt}`);
      const recovered = await CanonicalProjectRepository.open(directory);
      await expect(recovered.load()).resolves.toMatchObject({
        project: { name: "Initial" },
        generation,
      });
    }
  });
});

describe("ProjectPaths", () => {
  it("rejects symlinked project roots and managed directory components", async () => {
    const parent = await temporaryProjectDirectory();
    const project = join(parent, "project");
    const outside = join(parent, "outside");
    await Promise.all([mkdir(project), mkdir(outside)]);
    await symlink(project, join(parent, "project-link"));
    await expect(ProjectPaths.open(join(parent, "project-link"))).rejects.toBeInstanceOf(
      UnsafeProjectPathError,
    );

    const paths = await ProjectPaths.open(project);
    await symlink(outside, join(project, ".cinesim"));
    await expect(paths.ensureDirectory(".cinesim")).rejects.toBeInstanceOf(UnsafeProjectPathError);
  });

  it("rejects a symlink swapped into a derived directory before an operation", async () => {
    const parent = await temporaryProjectDirectory();
    const project = join(parent, "project");
    const outside = join(parent, "outside");
    await Promise.all([mkdir(project), mkdir(outside)]);
    const paths = await ProjectPaths.open(project);
    await paths.ensureLayout(["thumbnails"]);
    await rm(join(project, ".video", "thumbnails"), { recursive: true });
    await symlink(outside, join(project, ".video", "thumbnails"));

    await expect(paths.verifyDirectories([".video", ".video/thumbnails"])).rejects.toBeInstanceOf(
      UnsafeProjectPathError,
    );
  });

  it("rejects canonical file symlinks without reading or replacing their targets", async () => {
    const directory = await temporaryProjectDirectory();
    const outside = join(directory, "outside.json");
    await mkdir(join(directory, ".cinesim"));
    await writeFile(outside, "outside");
    await symlink(outside, join(directory, PROJECT_FILES.assets));
    const repository = await CanonicalProjectRepository.open(directory);

    await expect(repository.load()).rejects.toBeInstanceOf(UnsafeProjectPathError);
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
  });
});

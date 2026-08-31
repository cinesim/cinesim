import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SourceProjectRepository, SourceProjectWatcher, type SourceProjectSnapshot } from "../src";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SourceProjectWatcher", () => {
  it("keeps the last-known-good snapshot through invalid source and recovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-source-watcher-"));
    directories.push(directory);
    const initial = await SourceProjectRepository.create(directory, {
      id: "project_watcher",
      name: "Watcher",
    });
    const repository = await SourceProjectRepository.open(directory);
    const accepted: SourceProjectSnapshot[] = [];
    const diagnostics: string[][] = [];
    const watcher = new SourceProjectWatcher(repository, initial, {
      accepted: (snapshot) => {
        accepted.push(snapshot);
      },
      diagnostics: (items) => {
        diagnostics.push(items.map((item) => item.code));
      },
    });
    const sourcePath = join(directory, "main.jsx");
    const valid = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, "export const main = <composition");
    await watcher.checkNow();
    expect(accepted).toEqual([]);
    expect(diagnostics.at(-1)).toBeDefined();

    await writeFile(sourcePath, valid);
    await watcher.checkNow();
    expect(accepted).toEqual([]);
    expect(diagnostics.at(-1)).toEqual([]);

    await writeFile(sourcePath, "export const main = <composition");
    await watcher.checkNow();
    await writeFile(sourcePath, valid.replace('name="Main timeline"', 'name="Recovered"'));
    await watcher.checkNow();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.compilation.ir.compositions[0]!.name).toBe("Recovered");
    watcher.close();
  });

  it("never lets an older asynchronous load replace a newer request", async () => {
    let resolveOld!: (snapshot: SourceProjectSnapshot) => void;
    let resolveNew!: (snapshot: SourceProjectSnapshot) => void;
    let request = 0;
    const initial = { generation: "initial" } as SourceProjectSnapshot;
    const repository = {
      paths: { root: "/unused" },
      load: () =>
        new Promise<SourceProjectSnapshot>((resolve) => {
          request += 1;
          if (request === 1) resolveOld = resolve;
          else resolveNew = resolve;
        }),
    } as SourceProjectRepository;
    const accepted: string[] = [];
    const watcher = new SourceProjectWatcher(repository, initial, {
      accepted: (snapshot) => {
        accepted.push(snapshot.generation);
      },
      diagnostics: () => undefined,
    });
    const oldCheck = watcher.checkNow();
    const newCheck = watcher.checkNow();
    resolveNew({ generation: "new" } as SourceProjectSnapshot);
    await newCheck;
    resolveOld({ generation: "old" } as SourceProjectSnapshot);
    await oldCheck;
    expect(accepted).toEqual(["new"]);
  });
});

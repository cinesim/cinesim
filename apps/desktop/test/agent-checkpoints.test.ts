import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceProjectRepository } from "@cinesim/project-io";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AgentCheckpointStore } from "../src/main/agents/checkpoints";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("AgentCheckpointStore", () => {
  it("captures, diffs, and restores the manifest and reachable source without a worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-checkpoint-"));
    temporaryDirectories.push(directory);
    await SourceProjectRepository.create(directory, {
      id: "project_checkpoint",
      name: "Checkpoint",
    });

    const store = new AgentCheckpointStore(directory);
    const before = store.ref("session-1", 1, "before");
    const after = store.ref("session-1", 1, "after");
    await store.capture(before);
    const mainPath = join(directory, "main.jsx");
    await writeFile(
      join(directory, "Extra.jsx"),
      'export function Extra() { return <rect id="extra" fill="#fff" />; }\n',
    );
    await writeFile(
      mainPath,
      `import { Extra } from "./Extra.jsx";\n${await readFile(mainPath, "utf8")}`,
    );
    await store.capture(after);

    expect(await store.diffSummary(before, after)).toContain("main.jsx");
    await store.restore(before);
    await expect(readFile(mainPath, "utf8")).resolves.not.toContain("Extra");
    await expect(readFile(join(directory, "Extra.jsx"), "utf8")).rejects.toThrow();
  });
});

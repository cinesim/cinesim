import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AgentCheckpointStore } from "../src/main/agents/checkpoints";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("AgentCheckpointStore", () => {
  it("captures, diffs, and restores canonical files without a worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-checkpoint-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, ".cinesim"), { recursive: true });
    await writeFile(join(directory, "cinesim.json"), '{"name":"Before"}\n');
    await writeFile(join(directory, ".cinesim", "timeline.json"), '{"clips":[]}\n');

    const store = new AgentCheckpointStore(directory);
    const before = store.ref("session-1", 1, "before");
    const after = store.ref("session-1", 1, "after");
    await store.capture(before);
    await writeFile(join(directory, "cinesim.json"), '{"name":"After"}\n');
    await writeFile(join(directory, ".cinesim", "extra.json"), "{}\n");
    await store.capture(after);

    expect(await store.diffSummary(before, after)).toContain("cinesim.json");
    await store.restore(before);
    expect(await readFile(join(directory, "cinesim.json"), "utf8")).toBe('{"name":"Before"}\n');
    await expect(readFile(join(directory, ".cinesim", "extra.json"), "utf8")).rejects.toThrow();
  });
});

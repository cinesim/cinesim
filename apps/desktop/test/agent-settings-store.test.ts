import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSettingsStore } from "../src/main/agent-settings-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("AgentSettingsStore", () => {
  it("persists provider configuration and defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-settings-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "settings.json");
    const store = new AgentSettingsStore(path);
    await store.load();

    await store.update({
      provider: "codex",
      executablePath: "/opt/local/bin/codex",
      model: "gpt-test",
      permissionMode: "auto-edit",
    });
    await store.update({ defaultProvider: "codex" });

    const reloaded = new AgentSettingsStore(path);
    await reloaded.load();
    expect(reloaded.snapshot()).toMatchObject({
      defaultProvider: "codex",
      providers: {
        codex: {
          executablePath: "/opt/local/bin/codex",
          model: "gpt-test",
          permissionMode: "auto-edit",
        },
      },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });
});

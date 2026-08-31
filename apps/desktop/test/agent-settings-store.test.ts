import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AgentSettingsStore } from "../src/main/agents/settings-store";

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
    const executablePath = join(directory, "codex");
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o700);
    const store = new AgentSettingsStore(path);
    await store.load();

    await store.trustExecutable("codex", executablePath);
    await store.update({
      provider: "codex",
      model: "gpt-test",
      effort: "max",
      permissionMode: "auto-edit",
    });
    await store.update({ defaultProvider: "codex" });
    const canonicalExecutablePath = await realpath(executablePath);

    const reloaded = new AgentSettingsStore(path);
    await reloaded.load();
    expect(reloaded.snapshot()).toMatchObject({
      defaultProvider: "codex",
      providers: {
        codex: {
          executablePath: canonicalExecutablePath,
          model: "gpt-test",
          effort: "max",
          permissionMode: "auto-edit",
        },
      },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 2 });
    expect(await reloaded.requireTrustedExecutable("codex")).toBe(canonicalExecutablePath);
  });

  it("rejects a configured executable that changes after selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-settings-"));
    temporaryDirectories.push(directory);
    const executablePath = join(directory, "codex");
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o700);
    const store = new AgentSettingsStore(join(directory, "settings.json"));
    await store.load();
    await store.trustExecutable("codex", executablePath);
    await writeFile(executablePath, "#!/bin/sh\nexit 1\n");
    await expect(store.requireTrustedExecutable("codex")).rejects.toThrow("changed");
  });

  it("ignores executable paths from unsupported settings formats", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-agent-settings-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        defaultProvider: "codex",
        providers: {
          claude: {},
          codex: { executablePath: "/tmp/untrusted", permissionMode: "supervised" },
        },
      }),
    );
    const store = new AgentSettingsStore(path);
    await store.load();
    expect(store.snapshot().providers.codex.executablePath).toBe("");
    await expect(store.requireTrustedExecutable("codex")).rejects.toThrow("not configured");
  });
});

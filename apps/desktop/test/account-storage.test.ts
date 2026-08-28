import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DesktopAuthStorage } from "../src/main/account/storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("DesktopAuthStorage", () => {
  it("persists opaque Better Auth values without adding application metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-auth-storage-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "account-session.json");
    const storage = new DesktopAuthStorage(path);

    storage.setItem("cinesim-auth.cookie", "encrypted-value");

    expect(new DesktopAuthStorage(path).getItem("cinesim-auth.cookie")).toBe("encrypted-value");
    const file = await readFile(path, "utf8");
    expect(JSON.parse(file)).toEqual({
      version: 1,
      values: { "cinesim-auth.cookie": "encrypted-value" },
    });
    expect(file).not.toMatch(/createdAt|updatedAt|timestamp/);
  });

  it("treats malformed storage as empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-auth-storage-"));
    temporaryDirectories.push(directory);
    const storage = new DesktopAuthStorage(join(directory, "missing.json"));
    expect(storage.getItem("missing")).toBeNull();
  });
});

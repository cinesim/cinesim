import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DesktopAuthStorage } from "../src/main/account/storage";

const temporaryDirectories: string[] = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value: Buffer) => value.toString("utf8").replace(/^protected:/, ""),
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("DesktopAuthStorage", () => {
  it("persists Better Auth values only in an encrypted versioned envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-auth-storage-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "account-session.json");
    const storage = new DesktopAuthStorage(path, safeStorage);

    storage.setItem("cinesim-auth.cookie", "encrypted-value");

    expect(new DesktopAuthStorage(path, safeStorage).getItem("cinesim-auth.cookie")).toBe(
      "encrypted-value",
    );
    const file = await readFile(path, "utf8");
    expect(JSON.parse(file)).toMatchObject({
      version: 2,
      protection: "electron-safe-storage",
    });
    expect(file).not.toContain("encrypted-value");
    expect(file).not.toMatch(/createdAt|updatedAt|timestamp/);
  });

  it("migrates legacy plaintext on the next write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-auth-storage-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "account-session.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, values: { "cinesim-auth.cookie": "legacy-secret" } }),
    );
    const storage = new DesktopAuthStorage(path, safeStorage);
    expect(storage.getItem("cinesim-auth.cookie")).toBe("legacy-secret");
    storage.setItem("cinesim-auth.cookie", "fresh-secret");
    const file = await readFile(path, "utf8");
    expect(JSON.parse(file)).toMatchObject({ version: 2 });
    expect(file).not.toMatch(/legacy-secret|fresh-secret/);
  });

  it("fails closed when encrypted credentials cannot be decrypted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-auth-storage-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "account-session.json");
    const storage = new DesktopAuthStorage(path, safeStorage);
    storage.setItem("cinesim-auth.cookie", "secret");
    const unreadable = new DesktopAuthStorage(path, {
      ...safeStorage,
      decryptString: () => {
        throw new Error("Keychain rejected ciphertext");
      },
    });
    expect(unreadable.getItem("cinesim-auth.cookie")).toBeNull();
  });

  it("treats malformed storage as empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-auth-storage-"));
    temporaryDirectories.push(directory);
    const storage = new DesktopAuthStorage(join(directory, "missing.json"), safeStorage);
    expect(storage.getItem("missing")).toBeNull();
  });
});

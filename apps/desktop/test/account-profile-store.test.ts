import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DesktopAccountProfileStore } from "../src/main/account/profile-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("DesktopAccountProfileStore", () => {
  it("persists the last authenticated identity for offline project access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinesim-account-profile-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "profile.json");
    const user = {
      id: "user_fixture",
      name: "Cine Sim",
      email: "cine@example.com",
      emailVerified: true,
      image: null,
    };

    const store = new DesktopAccountProfileStore(path);
    store.set(user);
    expect(new DesktopAccountProfileStore(path).get()).toEqual(user);

    store.clear();
    expect(new DesktopAccountProfileStore(path).get()).toBeNull();
  });
});

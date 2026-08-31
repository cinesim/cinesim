import { describe, expect, it } from "vite-plus/test";
import {
  availableProjectOpenTargets,
  launchProjectOpenTarget,
} from "../src/main/projects/project-open-targets";

describe("project open targets", () => {
  it("always offers Finder and includes only installed optional applications", async () => {
    const targets = await availableProjectOpenTargets(async (path) => {
      if (path.endsWith("Cursor.app") || path.endsWith("Terminal.app")) return;
      throw new Error("missing");
    });

    expect(targets.map((target) => target.id)).toEqual(["finder", "cursor", "terminal"]);
  });

  it("launches a validated application without using a shell command", async () => {
    const launches: string[][] = [];
    await launchProjectOpenTarget("zed", "/Users/example/My Project", async (arguments_) => {
      launches.push([...arguments_]);
    });

    expect(launches).toEqual([["-a", "Zed", "/Users/example/My Project"]]);
  });

  it("starts Ghostty in the project working directory", async () => {
    const launches: string[][] = [];
    await launchProjectOpenTarget("ghostty", "/Users/example/My Project", async (arguments_) => {
      launches.push([...arguments_]);
    });

    expect(launches).toEqual([
      ["-na", "Ghostty", "--args", "--working-directory=/Users/example/My Project"],
    ]);
  });
});

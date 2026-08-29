import { describe, expect, it } from "vite-plus/test";
import { createProject, DEFAULT_SETTINGS } from "@cinesim/core";
import { ProjectPaths } from "@cinesim/project-io";
import {
  activeDerivedProject,
  beginDerivedProjectPreparation,
  completeDerivedProjectPreparation,
  failDerivedProjectPreparation,
  requireOpenDerivedProject,
} from "../src/main/derived-media/project-lifecycle";
import { emptyIndex } from "../src/main/derived-media/model";

describe("derived project lifecycle", () => {
  it("makes preparation, success, and failure explicit while retaining the previous project", async () => {
    const paths = await ProjectPaths.open(process.cwd());
    const preparingFirst = beginDerivedProjectPreparation({ status: "closed" }, paths.root);
    expect(activeDerivedProject(preparingFirst)).toBeNull();

    const open = completeDerivedProjectPreparation(preparingFirst, {
      directory: paths.root,
      paths,
      scope: { cacheKey: "project_cache", epoch: "project_epoch" },
      project: createProject({ name: "Lifecycle" }),
      settings: DEFAULT_SETTINGS,
      index: emptyIndex(),
    });
    const preparingNext = beginDerivedProjectPreparation(open, `${paths.root}/next`);
    const failure = new Error("index unavailable");
    const failed = failDerivedProjectPreparation(preparingNext, failure);

    expect(activeDerivedProject(failed)).toBe(open);
    expect(requireOpenDerivedProject(failed)).toBe(open);
    expect(failed).toMatchObject({
      status: "failed",
      directory: `${paths.root}/next`,
      error: failure,
    });
  });

  it("rejects access when the first project fails to prepare", () => {
    const preparing = beginDerivedProjectPreparation({ status: "closed" }, "/project");
    const failed = failDerivedProjectPreparation(preparing, new Error("failed"));

    expect(() => requireOpenDerivedProject(failed)).toThrow("No project is open for derived media");
  });
});

import type { Project, ProjectSettings } from "@cinesim/core";
import type { ProjectPaths } from "@cinesim/project-io";
import type { DerivedProjectScope } from "../../shared/api";
import type { PersistedIndex } from "./model";

export type DerivedProjectLifecycle =
  | { status: "closed" }
  | {
      status: "open";
      directory: string;
      paths: ProjectPaths;
      scope: DerivedProjectScope;
      project: Project;
      settings: ProjectSettings;
      index: PersistedIndex;
    };

export type OpenDerivedProject = Extract<DerivedProjectLifecycle, { status: "open" }>;

export function requireOpenDerivedProject(state: DerivedProjectLifecycle): OpenDerivedProject {
  if (state.status !== "open") throw new Error("No project is open for derived media");
  return state;
}

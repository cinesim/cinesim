import type { Project, ProjectSettings } from "@cinesim/core";
import type { ProjectPaths } from "@cinesim/project-io";
import type { DerivedProjectScope } from "../../shared/api";
import type { PersistedIndex } from "./model";

export interface OpenDerivedProject {
  status: "open";
  directory: string;
  paths: ProjectPaths;
  scope: DerivedProjectScope;
  project: Project;
  settings: ProjectSettings;
  index: PersistedIndex;
}

export type DerivedProjectLifecycle =
  | { status: "closed" }
  | OpenDerivedProject
  | { status: "preparing"; directory: string; previous: OpenDerivedProject | null }
  | { status: "failed"; directory: string; previous: OpenDerivedProject | null; error: Error };

export type PreparingDerivedProject = Extract<DerivedProjectLifecycle, { status: "preparing" }>;

export function beginDerivedProjectPreparation(
  state: DerivedProjectLifecycle,
  directory: string,
): PreparingDerivedProject {
  return { status: "preparing", directory, previous: activeDerivedProject(state) };
}

export function completeDerivedProjectPreparation(
  _state: PreparingDerivedProject,
  project: Omit<OpenDerivedProject, "status">,
): OpenDerivedProject {
  return { status: "open", ...project };
}

export function failDerivedProjectPreparation(
  state: PreparingDerivedProject,
  error: Error,
): DerivedProjectLifecycle {
  return { status: "failed", directory: state.directory, previous: state.previous, error };
}

export function activeDerivedProject(state: DerivedProjectLifecycle): OpenDerivedProject | null {
  if (state.status === "open") return state;
  if (state.status === "preparing" || state.status === "failed") return state.previous;
  return null;
}

export function requireOpenDerivedProject(state: DerivedProjectLifecycle): OpenDerivedProject {
  const project = activeDerivedProject(state);
  if (!project) throw new Error("No project is open for derived media");
  return project;
}

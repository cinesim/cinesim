import type { Project, ProjectSettings } from "@cinesim/core";
import type { DerivedProjectScope } from "./derived-media";

export interface DesktopProjectSession {
  directory: string;
  derivedScope: DerivedProjectScope;
  project: Project;
  settings: ProjectSettings;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
}

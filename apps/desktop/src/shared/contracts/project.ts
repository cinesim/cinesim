import type { Project, ProjectSettings } from "@cinesim/core";
import type { BuiltinSchema } from "@cinesim/compiler";
import type { IrDiagnostic, IrEditMap, IrProgram, TimelineProjection } from "@cinesim/ir";
import type { DerivedProjectScope } from "./derived-media";

export interface DesktopProjectSession {
  directory: string;
  derivedScope: DerivedProjectScope;
  project: Project;
  program: IrProgram;
  timeline: TimelineProjection;
  timelines: Record<string, TimelineProjection>;
  editMap: IrEditMap;
  propertySchemas: Readonly<Record<string, BuiltinSchema>>;
  diagnostics: IrDiagnostic[];
  settings: ProjectSettings;
  generation: string;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface CreateProjectLocation {
  token: string;
  directory: string;
}

export const PROJECT_OPEN_TARGET_IDS = [
  "finder",
  "vscode",
  "cursor",
  "zed",
  "ghostty",
  "terminal",
] as const;

export type ProjectOpenTargetId = (typeof PROJECT_OPEN_TARGET_IDS)[number];

export interface ProjectOpenTarget {
  id: ProjectOpenTargetId;
  label: string;
  kind: "file-manager" | "editor" | "terminal";
  iconDataUrl?: string;
}

export interface RecentProjectDetails {
  sizeBytes: number | null;
  createdAt: number | null;
  modifiedAt: number | null;
}

export interface DesktopCommandResult {
  summary: string;
  changedIds: string[];
  createdIds: string[];
}

import type { AssetId, DecoderAvailability, Project, ProjectSettings } from "@cinesim/core";
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
  diskValid: boolean;
  candidateDiagnostics: IrDiagnostic[];
  settings: ProjectSettings;
  generation: string;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface DesktopProjectGuidance {
  managedBlock: string;
  defaultCustomInstructions: string;
  projectCustomInstructions: string | null;
}

export interface CreateProjectLocation {
  token: string;
  directory: string;
}

export interface MediaDecoderConfigProbe {
  codec: string;
  description?: Uint8Array;
  codedWidth?: number;
  codedHeight?: number;
  sampleRate?: number;
  numberOfChannels?: number;
}

export interface MediaDecoderTrackProbe {
  availability: DecoderAvailability;
  config?: MediaDecoderConfigProbe;
}

export interface MediaDecoderProbe {
  assetId: AssetId;
  video?: MediaDecoderTrackProbe;
  audio?: MediaDecoderTrackProbe;
}

export interface PreparedMediaImport {
  token: string;
  probes: MediaDecoderProbe[];
}

export interface MediaDecoderProbeResult {
  assetId: AssetId;
  video?: DecoderAvailability;
  audio?: DecoderAvailability;
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

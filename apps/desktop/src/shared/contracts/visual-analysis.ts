import type { TimeUs } from "@cinesim/core";
import type { VisualIndexObservation, VisualIndexRange } from "@cinesim/project-io";
import type { DerivedProjectScope } from "./derived-media";

export interface VisualAnalysisRequest {
  requestId: string;
  projectScope: DerivedProjectScope;
  assetId: string;
  durationUs: TimeUs;
  acceptedGeneration: string;
}

export interface VisualAnalysisCompletion {
  requestId: string;
  options: Record<string, boolean | number | string | null>;
  coverage: VisualIndexRange[];
  observations: VisualIndexObservation[];
}

export interface VisualAnalysisFailure {
  requestId: string;
  code: string;
  detail: string;
}

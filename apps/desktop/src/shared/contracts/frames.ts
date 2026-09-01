import type { TimeUs } from "@cinesim/core";
import type { DerivedProjectScope, SourceFingerprint } from "./derived-media";

export const FRAME_QUALITY_LIMITS = {
  low: 640,
  medium: 1280,
  high: 1920,
} as const;

export type FrameQuality = keyof typeof FRAME_QUALITY_LIMITS;

export type FrameTarget =
  | { kind: "asset"; assetId: string }
  | { kind: "timeline"; sequenceId: string };

export interface FrameArtifact {
  version: 1;
  generatorVersion: string;
  target: FrameTarget;
  quality: FrameQuality;
  requestedTimeUs: TimeUs;
  normalizedTimeUs: TimeUs;
  renderedTimeUs: TimeUs;
  width: number;
  height: number;
  bytes: number;
  path: string;
  metadataPath: string;
  sourceFingerprint?: SourceFingerprint;
  acceptedGeneration?: string;
  cached: boolean;
  derived: true;
}

export interface FrameRenderRequest {
  requestId: string;
  projectScope: DerivedProjectScope;
  target: FrameTarget;
  quality: FrameQuality;
  requestedTimeUs: TimeUs;
  normalizedTimeUs: TimeUs;
  width: number;
  height: number;
  acceptedGeneration: string;
}

export interface FrameRenderCompletion {
  requestId: string;
  renderedTimeUs: TimeUs;
  width: number;
  height: number;
  png: Uint8Array;
}

export interface FrameRenderFailure {
  requestId: string;
  code: string;
  detail: string;
}

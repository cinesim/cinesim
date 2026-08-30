import { z } from "zod";
import {
  assetIdSchema,
  clipIdSchema,
  projectIdSchema,
  sequenceIdSchema,
  trackIdSchema,
} from "../ids";
import { timeUs } from "../project/types";
import type { CloudAssetId, CloudProjectId } from "../project/types";

export const timeUsSchema = z.number().int().nonnegative().safe().transform(timeUs);

export const transformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scaleX: z.number().finite(),
  scaleY: z.number().finite(),
  opacity: z.number().min(0).max(1),
  fit: z.enum(["contain", "cover", "fill"]),
});

export const cloudProjectIdSchema = z.custom<CloudProjectId>(
  (value) =>
    typeof value === "string" && /^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u.test(value),
  "Invalid cloud project ID",
);
export const cloudAssetIdSchema = z.custom<CloudAssetId>(
  (value) =>
    typeof value === "string" && /^cloud_asset_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u.test(value),
  "Invalid cloud asset ID",
);

export const assetSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), path: z.string().min(1) }),
  z.object({ kind: z.literal("cloud"), cloudAssetId: cloudAssetIdSchema }),
]);

export const assetSchema = z.object({
  id: assetIdSchema,
  kind: z.enum(["video", "audio", "image"]),
  name: z.string().min(1),
  source: assetSourceSchema,
  durationUs: timeUsSchema,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  hasAudio: z.boolean().optional(),
});

export const clipSchema = z.object({
  id: clipIdSchema,
  assetId: assetIdSchema,
  mediaKind: z.enum(["video", "audio"]),
  linkedClipId: clipIdSchema.optional(),
  timelineStartUs: timeUsSchema,
  sourceStartUs: timeUsSchema,
  sourceEndUs: timeUsSchema,
  fadeInUs: timeUsSchema.optional(),
  fadeOutUs: timeUsSchema.optional(),
  transform: transformSchema,
});

export const trackSchema = z.object({
  id: trackIdSchema,
  name: z.string().min(1),
  kind: z.enum(["video", "audio", "overlay"]),
  muted: z.boolean(),
  locked: z.boolean(),
  clips: z.array(clipSchema),
});

export const sequenceSchema = z.object({
  id: sequenceIdSchema,
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameRate: z.number().positive(),
  tracks: z.array(trackSchema),
});

export const projectSchema = z.object({
  version: z.literal(1),
  id: projectIdSchema,
  cloudProjectId: cloudProjectIdSchema.optional(),
  name: z.string().min(1),
  activeSequenceId: sequenceIdSchema,
  assets: z.array(assetSchema),
  sequences: z.array(sequenceSchema),
});

export const settingsSchema = z.object({
  version: z.literal(1),
  autosave: z.boolean(),
  defaultFilmstripIntervalSeconds: z.number().positive(),
  previewQuality: z.enum(["full", "half", "quarter"]),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  proxyGeneration: z.enum(["automatic", "manual"]),
  proxyProfile: z.enum(["space-saver", "balanced", "high-quality", "custom"]),
  proxyMaxLongEdge: z.number().int().min(320).max(7680),
  proxyFrameRateCap: z.union([z.literal(30), z.literal(60)]),
  proxyQuality: z.enum(["low", "medium", "high"]),
});

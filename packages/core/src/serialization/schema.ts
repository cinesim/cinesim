import { z } from "zod";

const persistentId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-zA-Z0-9][a-zA-Z0-9_-]*$`));
const timeUs = z.number().int().nonnegative().safe();

export const transformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scaleX: z.number().finite(),
  scaleY: z.number().finite(),
  opacity: z.number().min(0).max(1),
  fit: z.enum(["contain", "cover", "fill"]),
});

export const cloudProjectIdSchema = z
  .string()
  .regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/);
export const cloudAssetIdSchema = z.string().regex(/^cloud_asset_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/);

export const assetSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), path: z.string().min(1) }),
  z.object({ kind: z.literal("cloud"), cloudAssetId: cloudAssetIdSchema }),
]);

export const assetSchema = z.object({
  id: persistentId("asset"),
  kind: z.enum(["video", "audio", "image"]),
  name: z.string().min(1),
  source: assetSourceSchema,
  durationUs: timeUs,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  hasAudio: z.boolean().optional(),
});

export const clipSchema = z.object({
  id: persistentId("clip"),
  assetId: persistentId("asset"),
  mediaKind: z.enum(["video", "audio"]),
  linkedClipId: persistentId("clip").optional(),
  timelineStartUs: timeUs,
  sourceStartUs: timeUs,
  sourceEndUs: timeUs,
  fadeInUs: timeUs.optional(),
  fadeOutUs: timeUs.optional(),
  transform: transformSchema,
});

export const trackSchema = z.object({
  id: persistentId("track"),
  name: z.string().min(1),
  kind: z.enum(["video", "audio", "overlay"]),
  muted: z.boolean(),
  locked: z.boolean(),
  clips: z.array(clipSchema),
});

export const sequenceSchema = z.object({
  id: persistentId("sequence"),
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameRate: z.number().positive(),
  tracks: z.array(trackSchema),
});

export const projectSchema = z.object({
  version: z.literal(1),
  id: persistentId("project"),
  cloudProjectId: cloudProjectIdSchema.optional(),
  name: z.string().min(1),
  activeSequenceId: persistentId("sequence"),
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

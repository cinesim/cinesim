import { z } from "zod";
import { assetIdSchema } from "../ids";
import { EDITORIAL_NOTE_KINDS, timeUs } from "./types";
import type { CloudAssetId, CloudProjectId } from "./types";
import { projectSettingsSchema } from "./settings";

export const timeUsSchema = z.number().int().nonnegative().safe().transform(timeUs);

export const transformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scaleX: z.number().finite(),
  scaleY: z.number().finite(),
  rotation: z.number().finite(),
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

const decoderAvailabilitySchema = z.enum(["supported", "unsupported", "unknown"]);

const frameRateMetadataSchema = z.object({
  mode: z.enum(["constant", "variable"]),
  nominal: z.number().positive(),
  minimum: z.number().nonnegative(),
  maximum: z.number().positive(),
  average: z.number().positive(),
  probedFrames: z.number().int().nonnegative(),
});

const colorMetadataSchema = z.object({
  primaries: z.string().min(1).optional(),
  transfer: z.string().min(1).optional(),
  matrix: z.string().min(1).optional(),
  fullRange: z.boolean().optional(),
  bitDepth: z.number().int().positive().optional(),
  hdr: z.boolean(),
  uncertain: z.boolean(),
});

const videoMetadataSchema = z.object({
  codec: z.string().min(1).optional(),
  codecParameters: z.string().min(1).optional(),
  internalCodecId: z.string().min(1).optional(),
  decoderAvailability: decoderAvailabilitySchema,
  codedWidth: z.number().int().positive(),
  codedHeight: z.number().int().positive(),
  displayWidth: z.number().int().positive(),
  displayHeight: z.number().int().positive(),
  pixelAspectRatio: z.object({
    numerator: z.number().int().positive(),
    denominator: z.number().int().positive(),
  }),
  rotationDegrees: z.number().int(),
  frameRate: frameRateMetadataSchema,
  color: colorMetadataSchema,
});

const audioMetadataSchema = z.object({
  codec: z.string().min(1).optional(),
  codecParameters: z.string().min(1).optional(),
  internalCodecId: z.string().min(1).optional(),
  decoderAvailability: decoderAvailabilitySchema,
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  channelLayout: z.string().min(1),
});

export const assetTechnicalMetadataSchema = z.object({
  containerMimeType: z.string().min(1),
  durationSeconds: z.number().nonnegative().finite(),
  compatibility: z.enum(["supported", "partial", "unsupported", "unknown"]),
  video: videoMetadataSchema.optional(),
  audio: audioMetadataSchema.optional(),
});

export const editorialNoteSchema = z
  .object({
    id: z
      .string()
      .regex(/^note_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
      .max(128),
    kind: z.enum(EDITORIAL_NOTE_KINDS),
    text: z.string().trim().min(1).max(20_000),
  })
  .strict();

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
  technical: assetTechnicalMetadataSchema.optional(),
  inputColor: z.object({ policy: z.enum(["source-metadata", "assume-rec709"]) }).optional(),
  notes: z.array(editorialNoteSchema).max(1_000).optional(),
});

export const settingsSchema = projectSettingsSchema;

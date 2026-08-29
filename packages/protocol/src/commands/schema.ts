import { z } from "zod";
import {
  assetIdSchema,
  assetSchema,
  assetSourceSchema,
  clipIdSchema,
  sequenceIdSchema,
  trackIdSchema,
  transformSchema,
} from "@cinesim/core";
import type { EditorCommand } from "@cinesim/core";

export { assetIdSchema, clipIdSchema, sequenceIdSchema, trackIdSchema };
export const timeUsSchema = z.number().int().nonnegative().safe();

const editorCommandShapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("asset.import"), asset: assetSchema }),
  z.object({
    type: z.literal("asset.setSource"),
    assetId: assetIdSchema,
    source: assetSourceSchema,
  }),
  z.object({
    type: z.literal("asset.remove"),
    assetIds: z.array(assetIdSchema).min(1).max(500),
  }),
  z.object({
    type: z.literal("sequence.createFromAssets"),
    assetIds: z.array(assetIdSchema).min(1).max(500),
    name: z.string().trim().min(1).max(120).optional(),
    width: z.number().int().positive().safe().optional(),
    height: z.number().int().positive().safe().optional(),
    frameRate: z.number().positive().finite().optional(),
  }),
  z.object({ type: z.literal("sequence.remove"), sequenceId: sequenceIdSchema }),
  z.object({
    type: z.literal("sequence.deleteRanges"),
    sequenceId: sequenceIdSchema,
    ranges: z
      .array(z.object({ startUs: timeUsSchema, endUs: timeUsSchema }))
      .min(1)
      .max(500),
    mode: z.enum(["lift", "ripple"]),
  }),
  z.object({
    type: z.literal("track.add"),
    sequenceId: sequenceIdSchema,
    kind: z.enum(["video", "audio", "overlay"]),
    name: z.string().trim().min(1).optional(),
  }),
  z
    .object({
      type: z.literal("track.update"),
      trackId: trackIdSchema,
      name: z.string().trim().min(1).optional(),
      muted: z.boolean().optional(),
      locked: z.boolean().optional(),
    })
    .refine(
      (command) =>
        command.name !== undefined || command.muted !== undefined || command.locked !== undefined,
      { message: "Track update must change at least one field" },
    ),
  z.object({ type: z.literal("track.remove"), trackId: trackIdSchema }),
  z.object({
    type: z.literal("track.reorder"),
    trackId: trackIdSchema,
    index: z.number().int().nonnegative().safe(),
  }),
  z.object({
    type: z.literal("clip.add"),
    trackId: trackIdSchema,
    assetId: assetIdSchema,
    timelineStartUs: timeUsSchema,
    sourceStartUs: timeUsSchema.optional(),
    sourceEndUs: timeUsSchema.optional(),
    transform: transformSchema.partial().optional(),
    audioTrackId: trackIdSchema.optional(),
  }),
  z.object({ type: z.literal("clip.remove"), clipId: clipIdSchema }),
  z.object({
    type: z.literal("clip.move"),
    clipId: clipIdSchema,
    timelineStartUs: timeUsSchema,
    trackId: trackIdSchema.optional(),
  }),
  z.object({ type: z.literal("clip.trimStart"), clipId: clipIdSchema, atUs: timeUsSchema }),
  z.object({ type: z.literal("clip.trimEnd"), clipId: clipIdSchema, atUs: timeUsSchema }),
  z.object({
    type: z.literal("clip.setFade"),
    clipId: clipIdSchema,
    edge: z.enum(["in", "out"]),
    durationUs: timeUsSchema,
  }),
  z.object({ type: z.literal("clip.split"), clipId: clipIdSchema, atUs: timeUsSchema }),
]);

export const editorCommandSchema = editorCommandShapeSchema.pipe(z.custom<EditorCommand>());

export type ProtocolCommand = z.infer<typeof editorCommandSchema>;

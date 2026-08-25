import { z } from "zod";
import { assetSchema, transformSchema } from "@cinesim/core";

const assetId = z.string().regex(/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const clipId = z.string().regex(/^clip_[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const trackId = z.string().regex(/^track_[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const sequenceId = z.string().regex(/^sequence_[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const timeUs = z.number().int().nonnegative().safe();

export const editorCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("asset.import"), asset: assetSchema }),
  z.object({
    type: z.literal("asset.remove"),
    assetIds: z.array(assetId).min(1).max(500),
  }),
  z.object({
    type: z.literal("sequence.createFromAssets"),
    assetIds: z.array(assetId).min(1).max(500),
    name: z.string().trim().min(1).max(120).optional(),
    width: z.number().int().positive().safe().optional(),
    height: z.number().int().positive().safe().optional(),
    frameRate: z.number().positive().finite().optional(),
  }),
  z.object({ type: z.literal("sequence.remove"), sequenceId }),
  z.object({
    type: z.literal("track.add"),
    sequenceId,
    kind: z.enum(["video", "audio", "overlay"]),
    name: z.string().trim().min(1).optional(),
  }),
  z
    .object({
      type: z.literal("track.update"),
      trackId,
      name: z.string().trim().min(1).optional(),
      muted: z.boolean().optional(),
      locked: z.boolean().optional(),
    })
    .refine(
      (command) =>
        command.name !== undefined || command.muted !== undefined || command.locked !== undefined,
      { message: "Track update must change at least one field" },
    ),
  z.object({ type: z.literal("track.remove"), trackId }),
  z.object({
    type: z.literal("track.reorder"),
    trackId,
    index: z.number().int().nonnegative().safe(),
  }),
  z.object({
    type: z.literal("clip.add"),
    trackId,
    assetId,
    timelineStartUs: timeUs,
    sourceStartUs: timeUs.optional(),
    sourceEndUs: timeUs.optional(),
    transform: transformSchema.partial().optional(),
    audioTrackId: trackId.optional(),
  }),
  z.object({ type: z.literal("clip.remove"), clipId }),
  z.object({
    type: z.literal("clip.move"),
    clipId,
    timelineStartUs: timeUs,
    trackId: trackId.optional(),
  }),
  z.object({ type: z.literal("clip.trimStart"), clipId, atUs: timeUs }),
  z.object({ type: z.literal("clip.trimEnd"), clipId, atUs: timeUs }),
  z.object({ type: z.literal("clip.split"), clipId, atUs: timeUs }),
]);

export type ProtocolCommand = z.infer<typeof editorCommandSchema>;

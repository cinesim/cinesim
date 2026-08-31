import { z } from "zod";
import {
  assetIdSchema,
  assetSchema,
  assetSourceSchema,
  clipIdSchema,
  sequenceIdSchema,
  trackIdSchema,
  timeUsSchema,
  transformSchema,
} from "@cinesim/core";
import type { EditorCommand, SemanticEditorCommand } from "@cinesim/core";
import type { IrValue } from "@cinesim/ir";

export { assetIdSchema, clipIdSchema, sequenceIdSchema, trackIdSchema };
export { timeUsSchema };

const legacyEditorCommandShapeSchema = z.discriminatedUnion("type", [
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

export const legacyEditorCommandSchema = legacyEditorCommandShapeSchema.pipe(
  z.custom<EditorCommand>(),
);

const finite = z.number().finite();
export const irValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("angle"), unit: z.literal("deg"), value: finite }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("color"), value: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("decibels"), value: finite }).strict(),
  z.object({ kind: z.literal("length"), unit: z.literal("px"), value: finite }).strict(),
  z.object({ kind: z.literal("number"), value: finite }).strict(),
  z.object({ kind: z.literal("percent"), value: finite }).strict(),
  z
    .object({ kind: z.literal("rectangle"), values: z.tuple([finite, finite, finite, finite]) })
    .strict(),
  z.object({ kind: z.literal("resource"), assetId: assetIdSchema }).strict(),
  z.object({ kind: z.literal("string"), value: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal("time"), valueUs: timeUsSchema }).strict(),
  z.object({ kind: z.literal("vector"), values: z.tuple([finite, finite]) }).strict(),
]) as unknown as z.ZodType<IrValue>;

const semanticOnlyCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("property.set"),
      nodeId: z.string().min(1).max(512),
      property: z.string().min(1).max(120),
      value: irValueSchema,
      scope: z.enum(["instance", "definition", "materialized"]).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("clip.slip"), clipId: clipIdSchema, sourceStartUs: timeUsSchema })
    .strict(),
  z
    .object({
      type: z.literal("clip.duplicate"),
      clipId: clipIdSchema,
      timelineStartUs: timeUsSchema.optional(),
      trackId: trackIdSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("clip.link"), clipId: clipIdSchema, linkedClipId: clipIdSchema })
    .strict(),
  z.object({ type: z.literal("clip.unlink"), clipId: clipIdSchema }).strict(),
]);

export const editorCommandSchema = z.union([
  legacyEditorCommandShapeSchema,
  semanticOnlyCommandSchema,
]) as unknown as z.ZodType<SemanticEditorCommand>;

export type ProtocolCommand = z.infer<typeof editorCommandSchema>;

import { z } from "zod";

export type IdPrefix = "project" | "asset" | "sequence" | "track" | "clip";

export type ProjectId = `project_${string}`;
export type AssetId = `asset_${string}`;
export type SequenceId = `sequence_${string}`;
export type TrackId = `track_${string}`;
export type ClipId = `clip_${string}`;

const idSuffixSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);

export const projectIdSchema = z.templateLiteral(["project_", idSuffixSchema]);
export const assetIdSchema = z.templateLiteral(["asset_", idSuffixSchema]);
export const sequenceIdSchema = z.templateLiteral(["sequence_", idSuffixSchema]);
export const trackIdSchema = z.templateLiteral(["track_", idSuffixSchema]);
export const clipIdSchema = z.templateLiteral(["clip_", idSuffixSchema]);

export function nextId<TPrefix extends IdPrefix>(
  prefix: TPrefix,
  existingIds: Iterable<string>,
): `${TPrefix}_${string}` {
  let index = 1;
  for (const id of existingIds) {
    const match = id.match(new RegExp(`^${prefix}_(\\d+)$`));
    if (match) index = Math.max(index, Number(match[1]) + 1);
  }
  return `${prefix}_${String(index).padStart(6, "0")}`;
}

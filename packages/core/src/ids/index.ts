import { z } from "zod";

export type IdPrefix = "project" | "asset" | "sequence" | "track" | "clip";

export type ProjectId = `project_${string}`;
export type AssetId = `asset_${string}`;
export type SequenceId = `sequence_${string}`;
export type TrackId = `track_${string}`;
export type ClipId = `clip_${string}`;

export type PersistentId = ProjectId | AssetId | SequenceId | TrackId | ClipId;

const ID_PATTERN = /^(project|asset|sequence|track|clip)_[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const idSuffixSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);

export const projectIdSchema = z.templateLiteral(["project_", idSuffixSchema]);
export const assetIdSchema = z.templateLiteral(["asset_", idSuffixSchema]);
export const sequenceIdSchema = z.templateLiteral(["sequence_", idSuffixSchema]);
export const trackIdSchema = z.templateLiteral(["track_", idSuffixSchema]);
export const clipIdSchema = z.templateLiteral(["clip_", idSuffixSchema]);

export function isPersistentId(value: string): value is PersistentId {
  return ID_PATTERN.test(value);
}

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

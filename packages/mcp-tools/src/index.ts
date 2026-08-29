import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { EditorCommand, Project } from "@cinesim/core";
import {
  assetIdSchema,
  clipIdSchema,
  inspectAsset,
  inspectProject,
  inspectTimeline,
  listAssets,
  sequenceIdSchema,
  timeUsSchema,
  trackIdSchema,
} from "@cinesim/protocol";

export const CINESIM_MCP_TOOL_NAMES = [
  "project_inspect",
  "assets_list",
  "asset_inspect",
  "asset_delete",
  "timeline_inspect",
  "timeline_create_from_assets",
  "timeline_delete",
  "timeline_delete_ranges",
  "track_add",
  "track_update",
  "track_reorder",
  "track_delete",
  "clip_add",
  "clip_move",
  "clip_trim",
  "clip_fade",
  "clip_split",
  "clip_delete",
  "filmstrip_get",
  "frame_get",
] as const;

export type CinesimMcpToolName = (typeof CINESIM_MCP_TOOL_NAMES)[number];

export const CINESIM_MCP_COMMAND_SUPPORT = {
  "asset.import": { kind: "unsupported", reason: "Media import requires trusted inspection" },
  "asset.setSource": { kind: "unsupported", reason: "Source changes require adapter policy" },
  "asset.remove": { kind: "tool", toolName: "asset_delete" },
  "sequence.createFromAssets": { kind: "tool", toolName: "timeline_create_from_assets" },
  "sequence.remove": { kind: "tool", toolName: "timeline_delete" },
  "sequence.deleteRanges": { kind: "tool", toolName: "timeline_delete_ranges" },
  "track.add": { kind: "tool", toolName: "track_add" },
  "track.update": { kind: "tool", toolName: "track_update" },
  "track.remove": { kind: "tool", toolName: "track_delete" },
  "track.reorder": { kind: "tool", toolName: "track_reorder" },
  "clip.add": { kind: "tool", toolName: "clip_add" },
  "clip.remove": { kind: "tool", toolName: "clip_delete" },
  "clip.move": { kind: "tool", toolName: "clip_move" },
  "clip.trimStart": { kind: "tool", toolName: "clip_trim" },
  "clip.trimEnd": { kind: "tool", toolName: "clip_trim" },
  "clip.setFade": { kind: "tool", toolName: "clip_fade" },
  "clip.split": { kind: "tool", toolName: "clip_split" },
} as const satisfies Record<
  EditorCommand["type"],
  { kind: "tool"; toolName: CinesimMcpToolName } | { kind: "unsupported"; reason: string }
>;

export interface CinesimMcpCommandResult {
  [key: string]: unknown;
  summary: string;
  changedIds: string[];
  createdIds: string[];
  projectRevision?: number;
}

export interface CinesimMcpToolRuntime {
  project(): Project;
  directory(): string;
  projectRevision?(): number | undefined;
  execute(command: EditorCommand): Promise<CinesimMcpCommandResult>;
  perform<T extends Record<string, unknown>>(
    tool: { name: CinesimMcpToolName; detail: string; mutating: boolean },
    operation: () => Promise<T> | T,
  ): Promise<CallToolResult>;
  derivedFile(relativePath: string): Promise<{ path: string; exists: boolean }>;
}

const readOnly = { readOnlyHint: true, idempotentHint: true } as const;
const create = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const update = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
const destroy = { readOnlyHint: false, destructiveHint: true, idempotentHint: true } as const;

export function registerCinesimMcpTools(server: McpServer, runtime: CinesimMcpToolRuntime): void {
  const perform = <T extends Record<string, unknown>>(
    name: CinesimMcpToolName,
    detail: string,
    mutating: boolean,
    operation: () => Promise<T> | T,
  ) => runtime.perform({ name, detail, mutating }, operation);

  server.registerTool(
    "project_inspect",
    {
      title: "Inspect Cinesim project",
      description: "Return the current project identity, revision, and timeline counts.",
      annotations: readOnly,
    },
    () =>
      perform("project_inspect", "Inspect project", false, () => {
        const projectRevision = runtime.projectRevision?.();
        return {
          ...inspectProject(runtime.project()),
          directory: runtime.directory(),
          ...(projectRevision === undefined ? {} : { projectRevision }),
        };
      }),
  );
  server.registerTool(
    "assets_list",
    {
      title: "List project assets",
      description: "List canonical media references and technical metadata.",
      annotations: readOnly,
    },
    () =>
      perform("assets_list", "List project assets", false, () => ({
        assets: listAssets(runtime.project()),
      })),
  );
  server.registerTool(
    "asset_inspect",
    {
      title: "Inspect an asset",
      description: "Return one asset by stable ID.",
      inputSchema: { assetId: assetIdSchema },
      annotations: readOnly,
    },
    ({ assetId }) =>
      perform("asset_inspect", `Inspect ${assetId}`, false, () => ({
        asset: inspectAsset(runtime.project(), assetId),
      })),
  );
  server.registerTool(
    "asset_delete",
    {
      title: "Remove project assets",
      description:
        "Remove assets and every referencing timeline clip without deleting source media.",
      inputSchema: { assetIds: z.array(assetIdSchema).min(1).max(500) },
      annotations: destroy,
    },
    ({ assetIds }) =>
      perform("asset_delete", `Remove ${assetIds.length} assets`, true, () =>
        runtime.execute({ type: "asset.remove", assetIds }),
      ),
  );
  server.registerTool(
    "timeline_inspect",
    {
      title: "Inspect the active timeline",
      description: "Return tracks and clips with stable IDs and integer microsecond timing.",
      annotations: readOnly,
    },
    () =>
      perform("timeline_inspect", "Inspect active timeline", false, () =>
        inspectTimeline(runtime.project()),
      ),
  );
  server.registerTool(
    "timeline_create_from_assets",
    {
      title: "Create timeline from assets",
      description: "Create one timeline and place ordered assets sequentially in one command.",
      inputSchema: {
        assetIds: z.array(assetIdSchema).min(1).max(500),
        name: z.string().trim().min(1).max(120).optional(),
      },
      annotations: create,
    },
    ({ assetIds, name }) =>
      perform(
        "timeline_create_from_assets",
        `Create timeline from ${assetIds.length} assets`,
        true,
        () =>
          runtime.execute({
            type: "sequence.createFromAssets",
            assetIds,
            ...(name === undefined ? {} : { name }),
          }),
      ),
  );
  server.registerTool(
    "timeline_delete",
    {
      title: "Delete timeline",
      description: "Delete an unlocked timeline while preserving its source assets.",
      inputSchema: { sequenceId: sequenceIdSchema },
      annotations: destroy,
    },
    ({ sequenceId }) =>
      perform("timeline_delete", `Delete ${sequenceId}`, true, () =>
        runtime.execute({ type: "sequence.remove", sequenceId }),
      ),
  );
  server.registerTool(
    "timeline_delete_ranges",
    {
      title: "Delete timeline ranges",
      description: "Lift or ripple-delete absolute ranges from one sequence in one command.",
      inputSchema: {
        sequenceId: sequenceIdSchema,
        ranges: z
          .array(z.object({ startUs: timeUsSchema, endUs: timeUsSchema }))
          .min(1)
          .max(500),
        mode: z.enum(["lift", "ripple"]),
      },
      annotations: destroy,
    },
    ({ sequenceId, ranges, mode }) =>
      perform(
        "timeline_delete_ranges",
        `${mode === "lift" ? "Lift" : "Ripple-delete"} ${ranges.length} ranges`,
        true,
        () => runtime.execute({ type: "sequence.deleteRanges", sequenceId, ranges, mode }),
      ),
  );
  server.registerTool(
    "track_add",
    {
      title: "Add a timeline track",
      description: "Append a track through the canonical command handler.",
      inputSchema: {
        sequenceId: sequenceIdSchema.optional(),
        kind: z.enum(["video", "audio", "overlay"]),
        name: z.string().trim().min(1).optional(),
      },
      annotations: create,
    },
    (input) =>
      perform("track_add", `Add ${input.kind} track`, true, () =>
        runtime.execute({
          type: "track.add",
          sequenceId: input.sequenceId ?? runtime.project().activeSequenceId,
          kind: input.kind,
          ...(input.name === undefined ? {} : { name: input.name }),
        }),
      ),
  );
  server.registerTool(
    "track_update",
    {
      title: "Update a timeline track",
      description: "Rename, mute, or lock a track through one canonical command.",
      inputSchema: z
        .object({
          trackId: trackIdSchema,
          name: z.string().trim().min(1).optional(),
          muted: z.boolean().optional(),
          locked: z.boolean().optional(),
        })
        .refine(
          (input) =>
            input.name !== undefined || input.muted !== undefined || input.locked !== undefined,
          { message: "Provide at least one track field to update" },
        ),
      annotations: update,
    },
    (input) =>
      perform("track_update", `Update ${input.trackId}`, true, () =>
        runtime.execute({
          type: "track.update",
          trackId: input.trackId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.muted === undefined ? {} : { muted: input.muted }),
          ...(input.locked === undefined ? {} : { locked: input.locked }),
        }),
      ),
  );
  server.registerTool(
    "track_reorder",
    {
      title: "Reorder a timeline track",
      description: "Move a track to a zero-based index in its current sequence.",
      inputSchema: { trackId: trackIdSchema, index: z.number().int().nonnegative().safe() },
      annotations: update,
    },
    ({ trackId, index }) =>
      perform("track_reorder", `Move ${trackId} to track index ${index}`, true, () =>
        runtime.execute({ type: "track.reorder", trackId, index }),
      ),
  );
  server.registerTool(
    "track_delete",
    {
      title: "Delete an empty timeline track",
      description: "Remove an unlocked, empty track through the canonical command handler.",
      inputSchema: { trackId: trackIdSchema },
      annotations: destroy,
    },
    ({ trackId }) =>
      perform("track_delete", `Delete ${trackId}`, true, () =>
        runtime.execute({ type: "track.remove", trackId }),
      ),
  );
  server.registerTool(
    "clip_add",
    {
      title: "Add an asset clip",
      description: "Add an asset to a timeline track through the canonical command handler.",
      inputSchema: {
        trackId: trackIdSchema,
        audioTrackId: trackIdSchema.optional(),
        assetId: assetIdSchema,
        timelineStartUs: timeUsSchema,
        sourceStartUs: timeUsSchema.optional(),
        sourceEndUs: timeUsSchema.positive().optional(),
      },
      annotations: create,
    },
    (input) =>
      perform("clip_add", `Add ${input.assetId} to ${input.trackId}`, true, () =>
        runtime.execute({
          type: "clip.add",
          trackId: input.trackId,
          ...(input.audioTrackId === undefined ? {} : { audioTrackId: input.audioTrackId }),
          assetId: input.assetId,
          timelineStartUs: input.timelineStartUs,
          ...(input.sourceStartUs === undefined ? {} : { sourceStartUs: input.sourceStartUs }),
          ...(input.sourceEndUs === undefined ? {} : { sourceEndUs: input.sourceEndUs }),
        }),
      ),
  );
  server.registerTool(
    "clip_move",
    {
      title: "Move a clip",
      description: "Move a clip to an integer-microsecond timeline position.",
      inputSchema: {
        clipId: clipIdSchema,
        timelineStartUs: timeUsSchema,
        trackId: trackIdSchema.optional(),
      },
      annotations: update,
    },
    (input) =>
      perform("clip_move", `Move ${input.clipId} to ${input.timelineStartUs}µs`, true, () =>
        runtime.execute({
          type: "clip.move",
          clipId: input.clipId,
          timelineStartUs: input.timelineStartUs,
          ...(input.trackId ? { trackId: input.trackId } : {}),
        }),
      ),
  );
  server.registerTool(
    "clip_trim",
    {
      title: "Trim a clip edge",
      description: "Trim the start or end of a clip at an absolute timeline time.",
      inputSchema: {
        clipId: clipIdSchema,
        edge: z.enum(["start", "end"]),
        atUs: timeUsSchema,
      },
      annotations: destroy,
    },
    ({ clipId, edge, atUs }) =>
      perform("clip_trim", `Trim ${edge} of ${clipId} at ${atUs}µs`, true, () =>
        runtime.execute({
          type: edge === "start" ? "clip.trimStart" : "clip.trimEnd",
          clipId,
          atUs,
        }),
      ),
  );
  server.registerTool(
    "clip_fade",
    {
      title: "Set a clip fade",
      description: "Set one clip fade edge to an integer-microsecond duration.",
      inputSchema: {
        clipId: clipIdSchema,
        edge: z.enum(["in", "out"]),
        durationUs: timeUsSchema,
      },
      annotations: update,
    },
    ({ clipId, edge, durationUs }) =>
      perform("clip_fade", `Set ${edge} fade of ${clipId}`, true, () =>
        runtime.execute({ type: "clip.setFade", clipId, edge, durationUs }),
      ),
  );
  server.registerTool(
    "clip_split",
    {
      title: "Split a clip",
      description: "Split a clip at an absolute integer-microsecond timeline time.",
      inputSchema: { clipId: clipIdSchema, atUs: timeUsSchema.positive() },
      annotations: create,
    },
    ({ clipId, atUs }) =>
      perform("clip_split", `Split ${clipId} at ${atUs}µs`, true, () =>
        runtime.execute({ type: "clip.split", clipId, atUs }),
      ),
  );
  server.registerTool(
    "clip_delete",
    {
      title: "Delete a clip",
      description: "Delete a timeline clip by stable ID.",
      inputSchema: { clipId: clipIdSchema },
      annotations: destroy,
    },
    ({ clipId }) =>
      perform("clip_delete", `Delete ${clipId}`, true, () =>
        runtime.execute({ type: "clip.remove", clipId }),
      ),
  );
  server.registerTool(
    "filmstrip_get",
    {
      title: "Get a derived filmstrip",
      description: "Return the expected local path and availability of a sparse contact sheet.",
      inputSchema: { assetId: assetIdSchema },
      annotations: readOnly,
    },
    ({ assetId }) =>
      perform("filmstrip_get", `Find filmstrip for ${assetId}`, false, async () => ({
        assetId,
        ...(await runtime.derivedFile(join(".video", "filmstrips", `${assetId}.jpg`))),
        derived: true,
      })),
  );
  server.registerTool(
    "frame_get",
    {
      title: "Get a derived exact frame",
      description: "Return the expected local path and availability of an exact extracted frame.",
      inputSchema: { assetId: assetIdSchema, atUs: timeUsSchema },
      annotations: readOnly,
    },
    ({ assetId, atUs }) =>
      perform("frame_get", `Find ${assetId} frame at ${atUs}µs`, false, async () => ({
        assetId,
        atUs,
        ...(await runtime.derivedFile(join(".video", "frames", `${assetId}-${atUs}.png`))),
        derived: true,
      })),
  );
}

export async function localDerivedFile(path: string): Promise<{ path: string; exists: boolean }> {
  return { path, exists: existsSync(path) };
}

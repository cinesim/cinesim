#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AssetId, ClipId, SequenceId, TrackId } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { inspectAsset, inspectProject, inspectTimeline, listAssets } from "@cinesim/protocol";
import { DiskProjectStore } from "@cinesim/cli/project-store";

const projectDirectory = process.env.CINESIM_PROJECT ?? process.cwd();
const server = new McpServer({ name: "cinesim", version: "0.1.0" });
const log = createCinesimLogger({ service: "mcp" });

const textResult = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const failure = (error: unknown) => {
  log.error({ err: error }, "MCP operation failed");
  return {
    isError: true,
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
    ],
  };
};

async function loaded() {
  return new DiskProjectStore(projectDirectory).load();
}

server.registerTool(
  "project_inspect",
  {
    title: "Inspect Cinesim project",
    description: "Return concise project identity and timeline counts.",
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => {
    try {
      const store = await loaded();
      return textResult({ ...inspectProject(store.project), directory: store.directory });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "assets_list",
  {
    title: "List project assets",
    description: "List canonical media references and technical metadata.",
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => {
    try {
      const store = await loaded();
      return textResult({ assets: listAssets(store.project) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "asset_inspect",
  {
    title: "Inspect an asset",
    description: "Return one asset by stable ID.",
    inputSchema: z.object({ assetId: z.string().regex(/^asset_/) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ assetId }) => {
    try {
      const store = await loaded();
      return textResult({ asset: inspectAsset(store.project, assetId as AssetId) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "timeline_inspect",
  {
    title: "Inspect the active timeline",
    description: "Return tracks and clips with stable IDs and integer microsecond timing.",
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => {
    try {
      const store = await loaded();
      return textResult(inspectTimeline(store.project));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "track_add",
  {
    title: "Add a timeline track",
    description: "Append a track through the canonical command handler.",
    inputSchema: z.object({
      sequenceId: z
        .string()
        .regex(/^sequence_/)
        .optional(),
      kind: z.enum(["video", "audio", "overlay"]),
      name: z.string().trim().min(1).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (input) => {
    try {
      const store = await loaded();
      const result = await store.execute({
        type: "track.add",
        sequenceId: (input.sequenceId ?? store.project.activeSequenceId) as SequenceId,
        kind: input.kind,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
      return textResult({ summary: result.summary, createdIds: result.createdIds });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "track_update",
  {
    title: "Update a timeline track",
    description: "Rename, mute, or lock a track through one canonical command.",
    inputSchema: z
      .object({
        trackId: z.string().regex(/^track_/),
        name: z.string().trim().min(1).optional(),
        muted: z.boolean().optional(),
        locked: z.boolean().optional(),
      })
      .refine(
        (input) =>
          input.name !== undefined || input.muted !== undefined || input.locked !== undefined,
        { message: "Provide at least one track field to update" },
      ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (input) => {
    try {
      const store = await loaded();
      const result = await store.execute({
        type: "track.update",
        trackId: input.trackId as TrackId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.muted === undefined ? {} : { muted: input.muted }),
        ...(input.locked === undefined ? {} : { locked: input.locked }),
      });
      return textResult({ summary: result.summary, changedIds: result.changedIds });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "track_reorder",
  {
    title: "Reorder a timeline track",
    description: "Move a track to a zero-based index in its current sequence.",
    inputSchema: z.object({
      trackId: z.string().regex(/^track_/),
      index: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ trackId, index }) => {
    try {
      const store = await loaded();
      const result = await store.execute({
        type: "track.reorder",
        trackId: trackId as TrackId,
        index,
      });
      return textResult({ summary: result.summary, changedIds: result.changedIds });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "track_delete",
  {
    title: "Delete an empty timeline track",
    description: "Remove an unlocked, empty track through the canonical command handler.",
    inputSchema: z.object({ trackId: z.string().regex(/^track_/) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ trackId }) => {
    try {
      const store = await loaded();
      const result = await store.execute({
        type: "track.remove",
        trackId: trackId as TrackId,
      });
      return textResult({ summary: result.summary, changedIds: result.changedIds });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "clip_add",
  {
    title: "Add an asset clip",
    description: "Add an asset to a timeline track through the canonical command handler.",
    inputSchema: z.object({
      trackId: z.string().regex(/^track_/),
      assetId: z.string().regex(/^asset_/),
      timelineStartUs: z.number().int().nonnegative(),
      sourceStartUs: z.number().int().nonnegative().optional(),
      sourceEndUs: z.number().int().positive().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (input) => {
    try {
      const store = await loaded();
      const result = await store.execute({
        type: "clip.add",
        trackId: input.trackId as TrackId,
        assetId: input.assetId as AssetId,
        timelineStartUs: input.timelineStartUs,
        ...(input.sourceStartUs === undefined ? {} : { sourceStartUs: input.sourceStartUs }),
        ...(input.sourceEndUs === undefined ? {} : { sourceEndUs: input.sourceEndUs }),
      });
      return textResult({ summary: result.summary, createdIds: result.createdIds });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "clip_move",
  {
    title: "Move a clip",
    description: "Move a clip to an integer-microsecond timeline position.",
    inputSchema: z.object({
      clipId: z.string().regex(/^clip_/),
      timelineStartUs: z.number().int().nonnegative(),
      trackId: z
        .string()
        .regex(/^track_/)
        .optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (input) => {
    try {
      const store = await loaded();
      const result = await store.execute({
        type: "clip.move",
        clipId: input.clipId as ClipId,
        timelineStartUs: input.timelineStartUs,
        ...(input.trackId ? { trackId: input.trackId as TrackId } : {}),
      });
      return textResult({ summary: result.summary, changedIds: result.changedIds });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "clip_trim",
  {
    title: "Trim a clip edge",
    description: "Trim the start or end of a clip at an absolute timeline time.",
    inputSchema: z.object({
      clipId: z.string().regex(/^clip_/),
      edge: z.enum(["start", "end"]),
      atUs: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ clipId, edge, atUs }) => {
    try {
      const store = await loaded();
      const result = await store.execute({
        type: edge === "start" ? "clip.trimStart" : "clip.trimEnd",
        clipId: clipId as ClipId,
        atUs,
      });
      return textResult({ summary: result.summary, changedIds: result.changedIds });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "clip_split",
  {
    title: "Split a clip",
    description: "Split a clip at an absolute integer-microsecond timeline time.",
    inputSchema: z.object({
      clipId: z.string().regex(/^clip_/),
      atUs: z.number().int().positive(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ clipId, atUs }) => {
    try {
      const store = await loaded();
      const result = await store.execute({ type: "clip.split", clipId: clipId as ClipId, atUs });
      return textResult({ summary: result.summary, createdIds: result.createdIds });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "clip_delete",
  {
    title: "Delete a clip",
    description: "Delete a timeline clip by stable ID.",
    inputSchema: z.object({ clipId: z.string().regex(/^clip_/) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ clipId }) => {
    try {
      const store = await loaded();
      const result = await store.execute({ type: "clip.remove", clipId: clipId as ClipId });
      return textResult({ summary: result.summary });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "filmstrip_get",
  {
    title: "Get a derived filmstrip",
    description: "Return the expected local path and availability of a sparse contact sheet.",
    inputSchema: z.object({ assetId: z.string().regex(/^asset_/) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ assetId }) => {
    const path = join(projectDirectory, ".video", "filmstrips", `${assetId}.jpg`);
    return textResult({ assetId, path, exists: existsSync(path), derived: true });
  },
);

server.registerTool(
  "frame_get",
  {
    title: "Get a derived exact frame",
    description: "Return the expected local path and availability of an exact extracted frame.",
    inputSchema: z.object({
      assetId: z.string().regex(/^asset_/),
      atUs: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ assetId, atUs }) => {
    const path = join(projectDirectory, ".video", "frames", `${assetId}-${atUs}.png`);
    return textResult({ assetId, atUs, path, exists: existsSync(path), derived: true });
  },
);

await server.connect(new StdioServerTransport());

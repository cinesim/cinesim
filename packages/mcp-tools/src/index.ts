import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Project } from "@cinesim/core";
import type { IrEditMap, IrProgram } from "@cinesim/ir";
import { z } from "zod";
import {
  assetIdSchema,
  inspectAsset,
  inspectProject,
  inspectTimeline,
  listAssets,
  timeUsSchema,
} from "@cinesim/protocol";

/** MCP is an inspection/perception/service adapter, never a canonical project writer. */
export const CINESIM_MCP_TOOL_NAMES = [
  "project_inspect",
  "project_status",
  "assets_list",
  "asset_inspect",
  "timeline_inspect",
  "language_search",
  "transcript_get",
  "timeline_transcript_get",
  "transcript_generate",
  "transcript_regenerate",
  "transcript_cancel",
  "filmstrip_get",
  "frame_get",
] as const;

export type CinesimMcpToolName = (typeof CINESIM_MCP_TOOL_NAMES)[number];

export interface CinesimMcpToolRuntime {
  project(): Project;
  program(): IrProgram;
  editMap(): IrEditMap;
  directory(): string;
  projectRevision?(): number | undefined;
  projectStatus(): Promise<Record<string, unknown>>;
  languageSearch(query: string, limit: number): Promise<Record<string, unknown>[]>;
  transcriptGet(
    assetId: string,
    fromUs: number,
    toUs: number | undefined,
    limit: number,
  ): Promise<Record<string, unknown>>;
  timelineTranscriptGet(
    sequenceId: string | undefined,
    fromUs: number,
    toUs: number | undefined,
    limit: number,
  ): Promise<Record<string, unknown>>;
  transcriptJobs(
    action: "generate" | "regenerate" | "cancel",
    assetIds: string[],
  ): Promise<Record<string, unknown>>;
  perform<T extends Record<string, unknown>>(
    tool: { name: CinesimMcpToolName; detail: string; mutating: boolean },
    operation: () => Promise<T> | T,
  ): Promise<CallToolResult>;
  derivedFile(relativePath: string): Promise<{ path: string; exists: boolean }>;
}

const readOnly = { readOnlyHint: true, idempotentHint: true } as const;

export function registerCinesimMcpTools(server: McpServer, runtime: CinesimMcpToolRuntime): void {
  const perform = <T extends Record<string, unknown>>(
    name: CinesimMcpToolName,
    detail: string,
    operation: () => Promise<T> | T,
    mutating = false,
  ) => runtime.perform({ name, detail, mutating }, operation);

  server.registerTool(
    "project_status",
    {
      title: "Get compiler and project status",
      description:
        "Report the accepted generation, disk validity, bounded candidate diagnostics, last valid composition, and background work.",
      annotations: readOnly,
    },
    () => perform("project_status", "Inspect compiler status", () => runtime.projectStatus()),
  );
  server.registerTool(
    "project_inspect",
    {
      title: "Inspect Cinesim project",
      description: "Return the accepted project identity, revision, and timeline counts.",
      annotations: readOnly,
    },
    () =>
      perform("project_inspect", "Inspect project", () => {
        const projectRevision = runtime.projectRevision?.();
        return {
          ...inspectProject(runtime.program(), runtime.project()),
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
      perform("assets_list", "List project assets", () => ({
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
      perform("asset_inspect", `Inspect ${assetId}`, () => ({
        asset: inspectAsset(runtime.project(), assetId),
      })),
  );
  server.registerTool(
    "timeline_inspect",
    {
      title: "Inspect the active timeline",
      description: "Return accepted tracks and clips with stable IDs and microsecond timing.",
      annotations: readOnly,
    },
    () =>
      perform("timeline_inspect", "Inspect active timeline", () =>
        inspectTimeline(runtime.program(), runtime.editMap()),
      ),
  );
  server.registerTool(
    "language_search",
    {
      title: "Search the Cinesim language reference",
      description:
        "Fuzzy-search syntax, property constraints, editing recipes, and separate compiler, preview, and export capability states.",
      inputSchema: {
        query: z.string().max(200).default(""),
        limit: z.number().int().min(1).max(20).default(10),
      },
      annotations: readOnly,
    },
    ({ query, limit }) =>
      perform("language_search", `Search language reference for ${query || "all"}`, async () => ({
        query,
        results: await runtime.languageSearch(query, limit),
      })),
  );
  const transcriptRangeSchema = {
    fromUs: z.number().int().nonnegative().safe().default(0),
    toUs: timeUsSchema.optional(),
    limit: z.number().int().min(1).max(2_000).default(500),
  };
  server.registerTool(
    "transcript_get",
    {
      title: "Read an asset transcript",
      description:
        "Return a bounded source-time word projection from a disposable transcript artifact.",
      inputSchema: { assetId: assetIdSchema, ...transcriptRangeSchema },
      annotations: readOnly,
    },
    ({ assetId, fromUs, toUs, limit }) =>
      perform("transcript_get", `Read transcript for ${assetId}`, () =>
        runtime.transcriptGet(assetId, fromUs, toUs, limit),
      ),
  );
  server.registerTool(
    "timeline_transcript_get",
    {
      title: "Read a timeline transcript",
      description: "Return bounded dialogue words projected through accepted clip timing.",
      inputSchema: {
        sequenceId: z
          .string()
          .regex(/^sequence_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
          .optional(),
        ...transcriptRangeSchema,
      },
      annotations: readOnly,
    },
    ({ sequenceId, fromUs, toUs, limit }) =>
      perform("timeline_transcript_get", "Read projected timeline transcript", () =>
        runtime.timelineTranscriptGet(sequenceId, fromUs, toUs, limit),
      ),
  );
  const transcriptJobs = (
    name: "transcript_generate" | "transcript_regenerate" | "transcript_cancel",
    action: "generate" | "regenerate" | "cancel",
  ) =>
    server.registerTool(
      name,
      {
        title: `${action[0]!.toUpperCase()}${action.slice(1)} transcript jobs`,
        description: `${action} disposable transcription work without changing canonical project files.`,
        inputSchema: { assetIds: z.array(assetIdSchema).min(1).max(100) },
        annotations: { readOnlyHint: false, idempotentHint: action === "cancel" },
      },
      ({ assetIds }) =>
        perform(
          name,
          `${action} ${assetIds.length} transcript jobs`,
          () => runtime.transcriptJobs(action, assetIds),
          true,
        ),
    );
  transcriptJobs("transcript_generate", "generate");
  transcriptJobs("transcript_regenerate", "regenerate");
  transcriptJobs("transcript_cancel", "cancel");
  server.registerTool(
    "filmstrip_get",
    {
      title: "Get a derived filmstrip",
      description: "Return the local path and availability of a disposable contact sheet.",
      inputSchema: { assetId: assetIdSchema },
      annotations: readOnly,
    },
    ({ assetId }) =>
      perform("filmstrip_get", `Find filmstrip for ${assetId}`, async () => ({
        assetId,
        ...(await runtime.derivedFile(join(".video", "filmstrips", `${assetId}.jpg`))),
        derived: true,
      })),
  );
  server.registerTool(
    "frame_get",
    {
      title: "Get a derived exact frame",
      description: "Return the local path and availability of an exact disposable frame sample.",
      inputSchema: { assetId: assetIdSchema, atUs: timeUsSchema },
      annotations: readOnly,
    },
    ({ assetId, atUs }) =>
      perform("frame_get", `Find ${assetId} frame at ${atUs}µs`, async () => ({
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

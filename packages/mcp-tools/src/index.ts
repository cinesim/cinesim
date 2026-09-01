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
  "notes_inspect",
  "language_search",
  "export_capabilities",
  "export_start",
  "export_status",
  "export_cancel",
  "transcript_get",
  "timeline_transcript_get",
  "transcript_generate",
  "transcript_regenerate",
  "transcript_cancel",
  "visual_index_status",
  "visual_index_get",
  "visual_index_generate",
  "visual_index_regenerate",
  "visual_index_upsert",
  "visual_index_delete",
  "visual_index_clear",
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
  exportCapabilities(): Promise<Record<string, unknown>>;
  exportStart(request: {
    sequenceId?: string;
    presetId: "h264-aac-sdr-1080p" | "h264-aac-sdr-source";
    startUs?: number;
    endUs?: number;
    fileName?: string;
  }): Promise<Record<string, unknown>>;
  exportStatus(jobId?: string): Promise<Record<string, unknown>>;
  exportCancel(jobId: string): Promise<Record<string, unknown>>;
  transcriptGet(
    assetId: string,
    fromUs: number,
    toUs: number | undefined,
    limit: number,
    observationId?: string,
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
  visualIndexStatus(assetIds?: string[]): Promise<Record<string, unknown>>;
  visualIndexGet(
    assetId: string,
    fromUs: number,
    toUs: number | undefined,
    limit: number,
  ): Promise<Record<string, unknown>>;
  visualIndexGenerate(
    action: "generate" | "regenerate",
    assetIds: string[],
  ): Promise<Record<string, unknown>>;
  visualIndexUpsert(
    assetId: string,
    observations: Record<string, unknown>[],
  ): Promise<Record<string, unknown>>;
  visualIndexDelete(
    assetId: string,
    selector: { observationIds?: string[]; fromUs?: number; toUs?: number },
  ): Promise<Record<string, unknown>>;
  visualIndexClear(assetIds: string[]): Promise<Record<string, unknown>>;
  visualIndexObservationRange(
    assetId: string,
    observationId: string,
  ): Promise<{ sourceInUs: number; sourceOutUs: number }>;
  frameGet(
    target: { kind: "asset"; assetId: string } | { kind: "timeline"; sequenceId: string },
    atUs: number,
    quality: "low" | "medium" | "high",
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
    "notes_inspect",
    {
      title: "Inspect canonical notes",
      description:
        "Read bounded structured project, asset, or timeline notes. Change notes by editing TOML/JSX directly.",
      inputSchema: {
        target: z.enum(["project", "asset", "timeline"]).default("project"),
        assetId: assetIdSchema.optional(),
        sequenceId: z
          .string()
          .regex(/^sequence_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
          .optional(),
        limit: z.number().int().min(1).max(1_000).default(200),
      },
      annotations: readOnly,
    },
    ({ target, assetId, sequenceId, limit }) =>
      perform("notes_inspect", `Inspect ${target} notes`, () => {
        const project = runtime.project();
        const notes =
          target === "project"
            ? project.notes
            : target === "asset"
              ? project.assets.find(({ id }) => id === assetId)?.notes
              : project.sequences.find(({ id }) => id === sequenceId)?.notes;
        if (!notes) throw new Error(`Unknown or incomplete ${target} note target`);
        return {
          target,
          ...(assetId ? { assetId } : {}),
          ...(sequenceId ? { sequenceId } : {}),
          notes: notes.slice(0, limit),
          truncated: notes.length > limit,
        };
      }),
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
  const exportPresetSchema = z.enum(["h264-aac-sdr-1080p", "h264-aac-sdr-source"]);
  server.registerTool(
    "export_capabilities",
    {
      title: "Inspect export capabilities",
      description:
        "List explicit deterministic SDR export presets and renderer availability requirements.",
      annotations: readOnly,
    },
    () =>
      perform("export_capabilities", "Inspect export capabilities", () =>
        runtime.exportCapabilities(),
      ),
  );
  server.registerTool(
    "export_start",
    {
      title: "Start an accepted-timeline export",
      description:
        "Start one explicit H.264/AAC MP4 export from accepted IR into a visible disposable project artifact.",
      inputSchema: {
        sequenceId: z
          .string()
          .regex(/^sequence_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
          .optional(),
        presetId: exportPresetSchema,
        startUs: timeUsSchema.optional(),
        endUs: timeUsSchema.optional(),
        fileName: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.mp4$/u)
          .optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    ({ sequenceId, presetId, startUs, endUs, fileName }) =>
      perform(
        "export_start",
        `Export ${sequenceId ?? "the active timeline"} with ${presetId}`,
        () =>
          runtime.exportStart({
            presetId,
            ...(sequenceId ? { sequenceId } : {}),
            ...(startUs === undefined ? {} : { startUs }),
            ...(endUs === undefined ? {} : { endUs }),
            ...(fileName ? { fileName } : {}),
          }),
        true,
      ),
  );
  const exportJobIdSchema = z
    .string()
    .regex(/^export_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
    .max(128);
  server.registerTool(
    "export_status",
    {
      title: "Inspect export jobs",
      description: "Report bounded export progress, failure detail, and published artifact paths.",
      inputSchema: { jobId: exportJobIdSchema.optional() },
      annotations: readOnly,
    },
    ({ jobId }) =>
      perform("export_status", "Inspect export jobs", () => runtime.exportStatus(jobId)),
  );
  server.registerTool(
    "export_cancel",
    {
      title: "Cancel an export",
      description: "Cancel one active export and remove its unpublished partial artifact.",
      inputSchema: { jobId: exportJobIdSchema },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ jobId }) =>
      perform("export_cancel", `Cancel ${jobId}`, () => runtime.exportCancel(jobId), true),
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
        "Return a bounded source-time word projection from a disposable transcript artifact; an observation ID selects its exact visual-index range.",
      inputSchema: {
        assetId: assetIdSchema,
        observationId: z
          .string()
          .regex(/^observation_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
          .max(128)
          .optional(),
        ...transcriptRangeSchema,
      },
      annotations: readOnly,
    },
    ({ assetId, observationId, fromUs, toUs, limit }) =>
      perform("transcript_get", `Read transcript for ${assetId}`, () =>
        runtime.transcriptGet(assetId, fromUs, toUs, limit, observationId),
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
  const optionalAssetIds = z.array(assetIdSchema).min(1).max(100).optional();
  server.registerTool(
    "visual_index_status",
    {
      title: "Inspect visual-index coverage",
      description:
        "Report freshness, generator compatibility, observation counts, and covered source ranges for disposable visual indexes.",
      inputSchema: { assetIds: optionalAssetIds },
      annotations: readOnly,
    },
    ({ assetIds }) =>
      perform("visual_index_status", "Inspect visual-index coverage", () =>
        runtime.visualIndexStatus(assetIds),
      ),
  );
  server.registerTool(
    "visual_index_get",
    {
      title: "Read visual observations",
      description:
        "Return bounded timestamped descriptions from a validated disposable visual index.",
      inputSchema: { assetId: assetIdSchema, ...transcriptRangeSchema },
      annotations: readOnly,
    },
    ({ assetId, fromUs, toUs, limit }) =>
      perform("visual_index_get", `Read visual index for ${assetId}`, () =>
        runtime.visualIndexGet(assetId, fromUs, toUs, limit),
      ),
  );
  const visualIndexGeneration = (
    name: "visual_index_generate" | "visual_index_regenerate",
    action: "generate" | "regenerate",
  ) =>
    server.registerTool(
      name,
      {
        title: `${action[0]!.toUpperCase()}${action.slice(1)} visual indexes`,
        description: `${action} bounded local visual analysis into versioned disposable artifacts without changing canonical project files.`,
        inputSchema: { assetIds: z.array(assetIdSchema).min(1).max(8) },
        annotations: { readOnlyHint: false, idempotentHint: action === "generate" },
      },
      ({ assetIds }) =>
        perform(
          name,
          `${action} visual indexes for ${assetIds.length} assets`,
          () => runtime.visualIndexGenerate(action, assetIds),
          true,
        ),
    );
  visualIndexGeneration("visual_index_generate", "generate");
  visualIndexGeneration("visual_index_regenerate", "regenerate");
  const observationSchema = z
    .object({
      id: z
        .string()
        .regex(/^observation_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
        .max(128),
      sourceInUs: timeUsSchema,
      sourceOutUs: timeUsSchema,
      description: z.string().trim().min(1).max(2_000),
      people: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
      setting: z.string().trim().min(1).max(500).optional(),
      shotType: z.string().trim().min(1).max(100).optional(),
      tags: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
      continuity: z.string().trim().min(1).max(1_000).optional(),
      confidence: z.number().min(0).max(1).optional(),
      provenance: z.string().trim().min(1).max(200).optional(),
    })
    .strict();
  server.registerTool(
    "visual_index_upsert",
    {
      title: "Add or correct visual observations",
      description:
        "Upsert bounded timestamped observations in disposable perception state by artifact-local stable ID.",
      inputSchema: {
        assetId: assetIdSchema,
        observations: z.array(observationSchema).min(1).max(500),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ assetId, observations }) =>
      perform(
        "visual_index_upsert",
        `Upsert ${observations.length} observations for ${assetId}`,
        () => runtime.visualIndexUpsert(assetId, observations),
        true,
      ),
  );
  server.registerTool(
    "visual_index_delete",
    {
      title: "Delete visual observations",
      description: "Delete disposable observations by stable ID and/or intersecting source range.",
      inputSchema: {
        assetId: assetIdSchema,
        observationIds: z
          .array(
            z
              .string()
              .regex(/^observation_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
              .max(128),
          )
          .max(500)
          .optional(),
        fromUs: timeUsSchema.optional(),
        toUs: timeUsSchema.optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ assetId, observationIds, fromUs, toUs }) =>
      perform(
        "visual_index_delete",
        `Delete visual observations for ${assetId}`,
        () =>
          runtime.visualIndexDelete(assetId, {
            ...(observationIds ? { observationIds } : {}),
            ...(fromUs === undefined ? {} : { fromUs }),
            ...(toUs === undefined ? {} : { toUs }),
          }),
        true,
      ),
  );
  server.registerTool(
    "visual_index_clear",
    {
      title: "Clear visual indexes",
      description: "Discard disposable visual-index artifacts for selected assets.",
      inputSchema: { assetIds: z.array(assetIdSchema).min(1).max(100) },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ assetIds }) =>
      perform(
        "visual_index_clear",
        `Clear visual indexes for ${assetIds.length} assets`,
        () => runtime.visualIndexClear(assetIds),
        true,
      ),
  );
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
      title: "Generate or get a derived exact frame",
      description:
        "Generate a bounded asset or accepted-timeline frame and return its stable local path and exact timing metadata; an observation ID selects an asset-range midpoint.",
      inputSchema: {
        assetId: assetIdSchema.optional(),
        sequenceId: z
          .string()
          .regex(/^sequence_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
          .max(128)
          .optional(),
        atUs: timeUsSchema.optional(),
        observationId: z
          .string()
          .regex(/^observation_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
          .max(128)
          .optional(),
        quality: z.enum(["low", "medium", "high"]).default("medium"),
      },
      annotations: { idempotentHint: true },
    },
    ({ assetId, sequenceId, atUs, observationId, quality }) =>
      perform(
        "frame_get",
        `Generate an exact frame`,
        async () => {
          if ((!assetId && !sequenceId) || (assetId && sequenceId))
            throw new Error("frame_get requires exactly one of assetId or sequenceId");
          if (observationId && !assetId)
            throw new Error("observationId can only select an asset frame");
          const observationRange = observationId
            ? await runtime.visualIndexObservationRange(assetId!, observationId)
            : null;
          const selectedTime =
            atUs ??
            (observationRange
              ? Math.floor((observationRange.sourceInUs + observationRange.sourceOutUs) / 2)
              : undefined);
          if (selectedTime === undefined)
            throw new Error("frame_get requires atUs or observationId");
          return {
            ...(await runtime.frameGet(
              assetId ? { kind: "asset", assetId } : { kind: "timeline", sequenceId: sequenceId! },
              selectedTime,
              quality,
            )),
            atUs: selectedTime,
            ...(observationId ? { observationId } : {}),
          };
        },
        true,
      ),
  );
}

export async function localDerivedFile(path: string): Promise<{ path: string; exists: boolean }> {
  return { path, exists: existsSync(path) };
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Project } from "@cinesim/core";
import type { IrEditMap, IrProgram } from "@cinesim/ir";
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
  "assets_list",
  "asset_inspect",
  "timeline_inspect",
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
  ) => runtime.perform({ name, detail, mutating: false }, operation);

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

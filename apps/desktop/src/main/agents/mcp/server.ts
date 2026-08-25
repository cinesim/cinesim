import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AssetId, ClipId, EditorCommand, SequenceId, TrackId } from "@cinesim/core";
import { inspectAsset, inspectProject, inspectTimeline, listAssets } from "@cinesim/protocol";
import type { AgentPermissionMode } from "../../../shared/api";
import type { DesktopProjectStore } from "../../projects/project-store";

interface AgentToolSession {
  sessionId: string;
  token: string;
  projectDirectory: string;
  permissionMode: AgentPermissionMode;
}

export interface AgentToolHooks {
  onToolStarted(sessionId: string, toolName: string, detail: string): Promise<string>;
  onToolCompleted(
    sessionId: string,
    eventId: string,
    toolName: string,
    detail: string,
    failed?: boolean,
  ): Promise<void>;
  requestApproval(sessionId: string, toolName: string, detail: string): Promise<boolean>;
  onProjectChanged(): void;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 1024 * 1024) throw new Error("MCP request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function jsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export class AgentMcpServer {
  #sessionsByToken = new Map<string, AgentToolSession>();
  #server = createServer((request, response) => void this.#handle(request, response));
  #url: string | null = null;

  constructor(
    private readonly projectStore: DesktopProjectStore,
    private readonly hooks: AgentToolHooks,
  ) {}

  async start(): Promise<void> {
    if (this.#url) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind agent MCP server");
    this.#url = `http://127.0.0.1:${address.port}/mcp`;
  }

  registerSession(input: {
    sessionId: string;
    projectDirectory: string;
    permissionMode: AgentPermissionMode;
  }): { url: string; token: string } {
    if (!this.#url) throw new Error("Agent MCP server has not started");
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    this.#sessionsByToken.set(token, { ...input, token });
    return { url: this.#url, token };
  }

  revokeSession(sessionId: string): void {
    for (const [token, session] of this.#sessionsByToken) {
      if (session.sessionId === sessionId) this.#sessionsByToken.delete(token);
    }
  }

  async close(): Promise<void> {
    this.#sessionsByToken.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const session = this.#sessionsByToken.get(token);
    if (!session) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid agent session credential" }));
      return;
    }
    try {
      const body = await readJsonBody(request);
      const server = this.#createMcpServer(session);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      response.once("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32_603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        }),
      );
    }
  }

  #createMcpServer(session: AgentToolSession): McpServer {
    const server = new McpServer({ name: "cinesim", version: "0.1.0" });
    const requireProject = () => {
      if (this.projectStore.directory !== session.projectDirectory || !this.projectStore.project)
        throw new Error("The project attached to this agent is no longer open");
      return this.projectStore.project;
    };
    const perform = async <T extends Record<string, unknown>>(
      toolName: string,
      detail: string,
      operation: () => Promise<T> | T,
      destructive = false,
    ) => {
      const eventId = await this.hooks.onToolStarted(session.sessionId, toolName, detail);
      try {
        if (
          destructive &&
          session.permissionMode === "supervised" &&
          !(await this.hooks.requestApproval(session.sessionId, toolName, detail))
        ) {
          throw new Error("The user declined this Cinesim edit");
        }
        const result = await operation();
        await this.hooks.onToolCompleted(
          session.sessionId,
          eventId,
          toolName,
          "summary" in result && typeof result.summary === "string" ? result.summary : "Completed",
        );
        return jsonResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.hooks.onToolCompleted(session.sessionId, eventId, toolName, message, true);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    };
    const execute = async (command: EditorCommand) => {
      const output = await this.projectStore.execute(command);
      this.hooks.onProjectChanged();
      return {
        summary: output.result.summary,
        changedIds: output.result.changedIds,
        createdIds: output.result.createdIds,
        projectRevision: output.session.revision,
      };
    };

    server.registerTool(
      "project_inspect",
      {
        title: "Inspect Cinesim project",
        description: "Return the current project identity, revision, and timeline counts.",
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      () =>
        perform("project_inspect", "Inspect project", () => ({
          ...inspectProject(requireProject()),
          directory: session.projectDirectory,
          projectRevision: this.projectStore.session().revision,
        })),
    );
    server.registerTool(
      "assets_list",
      {
        title: "List assets",
        description: "List media references and technical metadata using stable asset IDs.",
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      () =>
        perform("assets_list", "List project assets", () => ({
          assets: listAssets(requireProject()),
        })),
    );
    server.registerTool(
      "asset_inspect",
      {
        title: "Inspect asset",
        description: "Inspect one asset by stable ID.",
        inputSchema: { assetId: z.string().regex(/^asset_/) },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ assetId }) =>
        perform("asset_inspect", `Inspect ${assetId}`, () => ({
          asset: inspectAsset(requireProject(), assetId as AssetId),
        })),
    );
    server.registerTool(
      "timeline_inspect",
      {
        title: "Inspect active timeline",
        description: "Return tracks and clips with stable IDs and integer-microsecond timing.",
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      () =>
        perform("timeline_inspect", "Inspect active timeline", () =>
          inspectTimeline(requireProject()),
        ),
    );
    server.registerTool(
      "track_add",
      {
        title: "Add track",
        description: "Append a track through a canonical command.",
        inputSchema: {
          sequenceId: z
            .string()
            .regex(/^sequence_/)
            .optional(),
          kind: z.enum(["video", "audio", "overlay"]),
          name: z.string().trim().min(1).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      (input) =>
        perform(
          "track_add",
          `Add ${input.kind} track`,
          () => {
            const project = requireProject();
            return execute({
              type: "track.add",
              sequenceId: (input.sequenceId ?? project.activeSequenceId) as SequenceId,
              kind: input.kind,
              ...(input.name === undefined ? {} : { name: input.name }),
            });
          },
          true,
        ),
    );
    server.registerTool(
      "track_update",
      {
        title: "Update track",
        description: "Rename, mute, or lock a track through one canonical command.",
        inputSchema: {
          trackId: z.string().regex(/^track_/),
          name: z.string().trim().min(1).optional(),
          muted: z.boolean().optional(),
          locked: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      (input) =>
        perform(
          "track_update",
          `Update ${input.trackId}`,
          () =>
            execute({
              type: "track.update",
              trackId: input.trackId as TrackId,
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.muted === undefined ? {} : { muted: input.muted }),
              ...(input.locked === undefined ? {} : { locked: input.locked }),
            }),
          true,
        ),
    );
    server.registerTool(
      "track_reorder",
      {
        title: "Reorder track",
        description: "Move a track to a zero-based index in its current sequence.",
        inputSchema: {
          trackId: z.string().regex(/^track_/),
          index: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      ({ trackId, index }) =>
        perform(
          "track_reorder",
          `Move ${trackId} to track index ${index}`,
          () => execute({ type: "track.reorder", trackId: trackId as TrackId, index }),
          true,
        ),
    );
    server.registerTool(
      "track_delete",
      {
        title: "Delete empty track",
        description: "Remove an unlocked, empty track through a canonical command.",
        inputSchema: { trackId: z.string().regex(/^track_/) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      ({ trackId }) =>
        perform(
          "track_delete",
          `Delete ${trackId}`,
          () => execute({ type: "track.remove", trackId: trackId as TrackId }),
          true,
        ),
    );
    server.registerTool(
      "clip_add",
      {
        title: "Add clip",
        description: "Add an asset to a timeline track through a canonical command.",
        inputSchema: {
          trackId: z.string().regex(/^track_/),
          audioTrackId: z
            .string()
            .regex(/^track_/)
            .optional(),
          assetId: z.string().regex(/^asset_/),
          timelineStartUs: z.number().int().nonnegative(),
          sourceStartUs: z.number().int().nonnegative().optional(),
          sourceEndUs: z.number().int().positive().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      (input) =>
        perform(
          "clip_add",
          `Add ${input.assetId} to ${input.trackId}`,
          () =>
            execute({
              type: "clip.add",
              trackId: input.trackId as TrackId,
              ...(input.audioTrackId === undefined
                ? {}
                : { audioTrackId: input.audioTrackId as TrackId }),
              assetId: input.assetId as AssetId,
              timelineStartUs: input.timelineStartUs,
              ...(input.sourceStartUs === undefined ? {} : { sourceStartUs: input.sourceStartUs }),
              ...(input.sourceEndUs === undefined ? {} : { sourceEndUs: input.sourceEndUs }),
            }),
          true,
        ),
    );
    server.registerTool(
      "clip_move",
      {
        title: "Move clip",
        description: "Move a clip to an integer-microsecond timeline position.",
        inputSchema: {
          clipId: z.string().regex(/^clip_/),
          timelineStartUs: z.number().int().nonnegative(),
          trackId: z
            .string()
            .regex(/^track_/)
            .optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      (input) =>
        perform(
          "clip_move",
          `Move ${input.clipId} to ${input.timelineStartUs}µs`,
          () =>
            execute({
              type: "clip.move",
              clipId: input.clipId as ClipId,
              timelineStartUs: input.timelineStartUs,
              ...(input.trackId ? { trackId: input.trackId as TrackId } : {}),
            }),
          true,
        ),
    );
    server.registerTool(
      "clip_trim",
      {
        title: "Trim clip",
        description: "Trim a clip edge at an absolute timeline time.",
        inputSchema: {
          clipId: z.string().regex(/^clip_/),
          edge: z.enum(["start", "end"]),
          atUs: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      ({ clipId, edge, atUs }) =>
        perform(
          "clip_trim",
          `Trim ${edge} of ${clipId} at ${atUs}µs`,
          () =>
            execute({
              type: edge === "start" ? "clip.trimStart" : "clip.trimEnd",
              clipId: clipId as ClipId,
              atUs,
            }),
          true,
        ),
    );
    server.registerTool(
      "clip_split",
      {
        title: "Split clip",
        description: "Split a clip at an absolute timeline time.",
        inputSchema: {
          clipId: z.string().regex(/^clip_/),
          atUs: z.number().int().positive(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      ({ clipId, atUs }) =>
        perform(
          "clip_split",
          `Split ${clipId} at ${atUs}µs`,
          () => execute({ type: "clip.split", clipId: clipId as ClipId, atUs }),
          true,
        ),
    );
    server.registerTool(
      "clip_delete",
      {
        title: "Delete clip",
        description: "Remove a clip through the canonical command path.",
        inputSchema: { clipId: z.string().regex(/^clip_/) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      ({ clipId }) =>
        perform(
          "clip_delete",
          `Delete ${clipId}`,
          () => execute({ type: "clip.remove", clipId: clipId as ClipId }),
          true,
        ),
    );
    server.registerTool(
      "filmstrip_get",
      {
        title: "Get filmstrip",
        description: "Return the local derived filmstrip path for an asset.",
        inputSchema: { assetId: z.string().regex(/^asset_/) },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ assetId }) =>
        perform("filmstrip_get", `Find filmstrip for ${assetId}`, () => ({
          assetId,
          path: join(session.projectDirectory, ".video", "filmstrips", `${assetId}.jpg`),
          derived: true,
        })),
    );
    server.registerTool(
      "frame_get",
      {
        title: "Get exact frame",
        description: "Return the local derived exact-frame path for an asset and time.",
        inputSchema: {
          assetId: z.string().regex(/^asset_/),
          atUs: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ assetId, atUs }) =>
        perform("frame_get", `Find ${assetId} frame at ${atUs}µs`, () => ({
          assetId,
          atUs,
          path: join(session.projectDirectory, ".video", "frames", `${assetId}-${atUs}.png`),
          derived: true,
        })),
    );
    return server;
  }
}

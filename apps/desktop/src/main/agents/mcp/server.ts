import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localDerivedFile, registerCinesimMcpTools } from "@cinesim/mcp-tools";
import type { CinesimMcpToolRuntime } from "@cinesim/mcp-tools";
import { ProjectPaths } from "@cinesim/project-io";
import type { AgentPermissionMode } from "../../../shared/contracts";
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
    const session = this.#authorizedSession(request, response);
    if (!session) return;
    try {
      await this.#serveRequest(session, request, response);
    } catch (error) {
      this.#writeRequestError(response, error);
    }
  }

  #authorizedSession(request: IncomingMessage, response: ServerResponse): AgentToolSession | null {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return null;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const session = this.#sessionsByToken.get(token);
    if (!session) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid agent session credential" }));
      return null;
    }
    return session;
  }

  async #serveRequest(
    session: AgentToolSession,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const server = this.#createMcpServer(session);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    response.once("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, body);
  }

  #writeRequestError(response: ServerResponse, error: unknown): void {
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32_603, message: error instanceof Error ? error.message : String(error) },
        id: null,
      }),
    );
  }

  #createMcpServer(session: AgentToolSession): McpServer {
    const server = new McpServer({ name: "cinesim", version: "0.1.0" });
    const requireProject = () => {
      if (this.projectStore.directory !== session.projectDirectory || !this.projectStore.project)
        throw new Error("The project attached to this agent is no longer open");
      return this.projectStore.project;
    };
    const runtime: CinesimMcpToolRuntime = {
      project: requireProject,
      program: () => this.projectStore.session().program,
      editMap: () => this.projectStore.session().editMap,
      directory: () => session.projectDirectory,
      projectRevision: () => this.projectStore.session().revision,
      execute: async (command) => {
        const output = await this.projectStore.execute(command);
        this.hooks.onProjectChanged();
        return {
          summary: output.result.summary,
          changedIds: output.result.changedIds,
          createdIds: output.result.createdIds,
          projectRevision: output.session.revision,
        };
      },
      perform: async (tool, operation) => {
        const eventId = await this.hooks.onToolStarted(session.sessionId, tool.name, tool.detail);
        try {
          if (
            tool.mutating &&
            session.permissionMode === "supervised" &&
            !(await this.hooks.requestApproval(session.sessionId, tool.name, tool.detail))
          ) {
            throw new Error("The user declined this Cinesim edit");
          }
          const result = await operation();
          await this.hooks.onToolCompleted(
            session.sessionId,
            eventId,
            tool.name,
            "summary" in result && typeof result.summary === "string"
              ? result.summary
              : "Completed",
          );
          return jsonResult(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.hooks.onToolCompleted(session.sessionId, eventId, tool.name, message, true);
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      },
      derivedFile: async (relativePath) => {
        const paths = await ProjectPaths.open(session.projectDirectory);
        const path = await paths.assertSafeDerivedFile(relativePath);
        return localDerivedFile(path);
      },
    };
    registerCinesimMcpTools(server, runtime);
    return server;
  }
}

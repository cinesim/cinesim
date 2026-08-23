import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AgentProviderRuntime,
  AgentRuntimeCallbacks,
  AgentRuntimeLaunchOptions,
} from "./agent-runtime";
import { asRecord, stringValue } from "./agent-runtime";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class CodexRuntime implements AgentProviderRuntime {
  #child: ChildProcessWithoutNullStreams | null = null;
  #nextRequestId = 1;
  #pending = new Map<number, PendingRequest>();
  #threadId: string | null = null;
  #activeTurnId: string | null = null;
  #sawAssistantDelta = false;
  #stopping = false;

  constructor(
    private readonly options: AgentRuntimeLaunchOptions,
    private readonly callbacks: AgentRuntimeCallbacks,
  ) {}

  async start(): Promise<void> {
    if (this.#child) return;
    const arguments_ = [
      "app-server",
      "-c",
      `mcp_servers.cinesim.url=${this.options.mcpUrl}`,
      "-c",
      'mcp_servers.cinesim.bearer_token_env_var="CINESIM_MCP_TOKEN"',
    ];
    const child = spawn(this.options.executablePath, arguments_, {
      cwd: this.options.cwd,
      env: { ...process.env, CINESIM_MCP_TOKEN: this.options.mcpToken },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      const detail = line.trim();
      if (detail) this.callbacks.onEvent({ kind: "notice", title: "Codex", detail });
    });
    child.once("error", (error) => this.callbacks.onExit(error.message));
    child.once("exit", (code, signal) => {
      this.#child = null;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Codex app-server exited"));
      }
      this.#pending.clear();
      if (!this.#stopping)
        this.callbacks.onExit(
          code === 0
            ? undefined
            : `Codex exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        );
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.#request("initialize", {
      clientInfo: { name: "cinesim_desktop", title: "Cinesim", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.#notify("initialized", undefined);
    const params = {
      cwd: this.options.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      developerInstructions: this.options.instructions,
      ...(this.options.model ? { model: this.options.model } : {}),
    };
    const opened = asRecord(
      await this.#request(
        this.options.providerSessionId ? "thread/resume" : "thread/start",
        this.options.providerSessionId
          ? { threadId: this.options.providerSessionId, ...params }
          : params,
      ),
    );
    const thread = asRecord(opened?.thread);
    this.#threadId = stringValue(thread?.id) ?? this.options.providerSessionId ?? null;
    if (!this.#threadId) throw new Error("Codex did not return a thread ID");
    this.callbacks.onProviderSessionId(this.#threadId);
  }

  async send(message: string): Promise<void> {
    if (!this.#threadId) throw new Error("Codex session is not ready");
    this.#sawAssistantDelta = false;
    const response = asRecord(
      await this.#request("turn/start", {
        threadId: this.#threadId,
        input: [{ type: "text", text: message }],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly" },
        effort: this.options.effort,
        ...(this.options.model ? { model: this.options.model } : {}),
      }),
    );
    this.#activeTurnId = stringValue(asRecord(response?.turn)?.id) ?? null;
    this.callbacks.onTurnStarted(this.#activeTurnId ?? undefined);
  }

  async interrupt(): Promise<void> {
    if (!this.#threadId || !this.#activeTurnId) return;
    await this.#request("turn/interrupt", {
      threadId: this.#threadId,
      turnId: this.#activeTurnId,
    });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    child.stdin.end();
    child.kill("SIGTERM");
    this.#child = null;
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      if (line.trim()) this.callbacks.onEvent({ kind: "notice", detail: line.trim() });
      return;
    }
    const message = asRecord(value);
    if (!message) return;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    const method = stringValue(message.method);
    if (!method) return;
    if (typeof message.id === "number" || typeof message.id === "string") {
      void this.#handleServerRequest(message.id, method, asRecord(message.params));
      return;
    }
    this.#handleNotification(method, asRecord(message.params));
  }

  #handleNotification(method: string, params: Record<string, unknown> | null): void {
    if (!params) return;
    if (method === "thread/started") {
      const id = stringValue(asRecord(params.thread)?.id);
      if (id) {
        this.#threadId = id;
        this.callbacks.onProviderSessionId(id);
      }
      return;
    }
    if (method === "turn/started") {
      this.#activeTurnId = stringValue(asRecord(params.turn)?.id) ?? this.#activeTurnId;
      this.callbacks.onTurnStarted(this.#activeTurnId ?? undefined);
      return;
    }
    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      const status = stringValue(turn?.status);
      const error = asRecord(turn?.error);
      this.#activeTurnId = null;
      this.callbacks.onTurnCompleted(
        status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed",
        stringValue(error?.message),
      );
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = asRecord(params.tokenUsage);
      const last = asRecord(tokenUsage?.last);
      const total = asRecord(tokenUsage?.total);
      const usedTokens = this.#tokenCount(last?.totalTokens);
      if (usedTokens > 0) {
        const maxTokens = this.#tokenCount(tokenUsage?.modelContextWindow);
        const totalProcessedTokens = this.#tokenCount(total?.totalTokens);
        const inputTokens = this.#tokenCount(last?.inputTokens);
        const cachedInputTokens = this.#tokenCount(last?.cachedInputTokens);
        const outputTokens = this.#tokenCount(last?.outputTokens);
        const reasoningOutputTokens = this.#tokenCount(last?.reasoningOutputTokens);
        this.callbacks.onTokenUsage({
          usedTokens: maxTokens > 0 ? Math.min(usedTokens, maxTokens) : usedTokens,
          ...(maxTokens > 0 ? { maxTokens } : {}),
          ...(inputTokens > 0 ? { inputTokens } : {}),
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
          ...(outputTokens > 0 ? { outputTokens } : {}),
          ...(reasoningOutputTokens > 0 ? { reasoningOutputTokens } : {}),
          ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
        });
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = stringValue(params.delta);
      if (delta) {
        this.#sawAssistantDelta = true;
        this.callbacks.onEvent({ kind: "assistant-message", text: delta });
      }
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const delta = stringValue(params.delta);
      if (delta) this.callbacks.onEvent({ kind: "reasoning", text: delta });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = asRecord(params.item);
      const type = stringValue(item?.type) ?? "Tool";
      if (type === "agentMessage" && method === "item/completed" && !this.#sawAssistantDelta) {
        const text = stringValue(item?.text);
        if (text) this.callbacks.onEvent({ kind: "assistant-message", text });
      } else if (type !== "mcpToolCall" && type !== "reasoning" && type !== "agentMessage") {
        const detail = stringValue(item?.command) ?? stringValue(item?.text);
        this.callbacks.onEvent({
          kind: method === "item/started" ? "tool-started" : "tool-completed",
          toolName: type,
          title: type,
          ...(detail ? { detail } : {}),
          status: method === "item/started" ? "running" : "completed",
        });
      }
      return;
    }
    if (method === "error") {
      const error = asRecord(params.error);
      this.callbacks.onEvent({
        kind: "error",
        title: "Codex error",
        detail: stringValue(error?.message) ?? JSON.stringify(params),
      });
    }
  }

  async #handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown> | null,
  ): Promise<void> {
    if (method.includes("requestApproval")) {
      const accepted = await this.callbacks.onApproval(
        method.includes("fileChange") ? "Allow file change?" : "Allow command?",
        JSON.stringify(params ?? {}, null, 2),
      );
      this.#respond(id, { decision: accepted ? "accept" : "decline" });
      return;
    }
    this.#respondError(id, -32_601, `Unsupported Codex request: ${method}`);
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextRequestId++;
    this.#write({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timeout });
    });
  }

  #notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  #respond(id: number | string, result: unknown): void {
    this.#write({ id, result });
  }

  #respondError(id: number | string, code: number, message: string): void {
    this.#write({ id, error: { code, message } });
  }

  #write(value: unknown): void {
    if (!this.#child || this.#child.stdin.destroyed)
      throw new Error("Codex input stream is closed");
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #tokenCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : 0;
  }
}

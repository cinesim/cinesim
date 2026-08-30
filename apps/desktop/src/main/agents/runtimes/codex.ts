import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AgentProviderRuntime,
  AgentRuntimeCallbacks,
  AgentRuntimeLaunchOptions,
} from "./types";
import { asRecord, MAX_PROVIDER_LINE_CHARACTERS, stringValue } from "./types";
import { CODEX_REQUEST_TIMEOUT_MS } from "../runtime-policy";
import type { AgentTokenUsage } from "../../../shared/contracts";

type RuntimeTokenUsage = Omit<AgentTokenUsage, "updatedAt">;

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
    if (line.length > MAX_PROVIDER_LINE_CHARACTERS) {
      this.callbacks.onEvent({
        kind: "error",
        title: "Codex output rejected",
        detail: "The provider emitted a message beyond the runtime size limit.",
      });
      return;
    }
    const message = this.#parseLine(line);
    if (!message || this.#settlePendingRequest(message)) return;
    this.#dispatchIncomingMessage(message);
  }

  #parseLine(line: string): Record<string, unknown> | null {
    try {
      return asRecord(JSON.parse(line) as unknown);
    } catch {
      if (line.trim()) this.callbacks.onEvent({ kind: "notice", detail: line.trim() });
      return null;
    }
  }

  #settlePendingRequest(message: Record<string, unknown>): boolean {
    if (typeof message.id !== "number" || (!("result" in message) && !("error" in message)))
      return false;
    const pending = this.#pending.get(message.id);
    if (!pending) return true;
    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
    return true;
  }

  #dispatchIncomingMessage(message: Record<string, unknown>): void {
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

    switch (method) {
      case "thread/started":
        return this.#handleThreadStarted(params);
      case "turn/started":
        return this.#handleTurnStarted(params);
      case "turn/completed":
        return this.#handleTurnCompleted(params);
      case "thread/tokenUsage/updated":
        return this.#handleTokenUsage(params);
      case "item/agentMessage/delta":
        return this.#handleAssistantDelta(params);
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return this.#handleReasoningDelta(params);
      case "item/started":
      case "item/completed":
        return this.#handleItemLifecycle(method, params);
      case "error":
        return this.#handleError(params);
    }
  }

  #handleThreadStarted(params: Record<string, unknown>): void {
    const id = stringValue(asRecord(params.thread)?.id);
    if (!id) return;

    this.#threadId = id;
    this.callbacks.onProviderSessionId(id);
  }

  #handleTurnStarted(params: Record<string, unknown>): void {
    this.#activeTurnId = stringValue(asRecord(params.turn)?.id) ?? this.#activeTurnId;
    this.callbacks.onTurnStarted(this.#activeTurnId ?? undefined);
  }

  #handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = asRecord(params.turn);
    const status = stringValue(turn?.status);
    const error = asRecord(turn?.error);
    this.#activeTurnId = null;

    this.callbacks.onTurnCompleted(
      status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed",
      stringValue(error?.message),
    );
  }

  #handleTokenUsage(params: Record<string, unknown>): void {
    const usage = this.#readTokenUsage(params);
    if (usage) this.callbacks.onTokenUsage(usage);
  }

  #readTokenUsage(params: Record<string, unknown>): RuntimeTokenUsage | null {
    const tokenUsage = asRecord(params.tokenUsage);
    const last = asRecord(tokenUsage?.last);
    const total = asRecord(tokenUsage?.total);
    const usedTokens = this.#tokenCount(last?.totalTokens);
    if (usedTokens === 0) return null;

    const maxTokens = this.#tokenCount(tokenUsage?.modelContextWindow);
    const inputTokens = this.#tokenCount(last?.inputTokens);
    const cachedInputTokens = this.#tokenCount(last?.cachedInputTokens);
    const outputTokens = this.#tokenCount(last?.outputTokens);
    const reasoningOutputTokens = this.#tokenCount(last?.reasoningOutputTokens);
    const totalProcessedTokens = this.#tokenCount(total?.totalTokens);
    const usage: RuntimeTokenUsage = {
      usedTokens: maxTokens > 0 ? Math.min(usedTokens, maxTokens) : usedTokens,
    };

    if (maxTokens > 0) usage.maxTokens = maxTokens;
    if (inputTokens > 0) usage.inputTokens = inputTokens;
    if (cachedInputTokens > 0) usage.cachedInputTokens = cachedInputTokens;
    if (outputTokens > 0) usage.outputTokens = outputTokens;
    if (reasoningOutputTokens > 0) usage.reasoningOutputTokens = reasoningOutputTokens;
    if (totalProcessedTokens > usedTokens) usage.totalProcessedTokens = totalProcessedTokens;

    return usage;
  }

  #handleAssistantDelta(params: Record<string, unknown>): void {
    const delta = stringValue(params.delta);
    if (!delta) return;

    this.#sawAssistantDelta = true;
    this.callbacks.onEvent({ kind: "assistant-message", text: delta });
  }

  #handleReasoningDelta(params: Record<string, unknown>): void {
    const delta = stringValue(params.delta);
    if (delta) this.callbacks.onEvent({ kind: "reasoning", text: delta });
  }

  #handleItemLifecycle(
    method: "item/started" | "item/completed",
    params: Record<string, unknown>,
  ): void {
    const item = asRecord(params.item);
    const type = stringValue(item?.type) ?? "Tool";

    if (type === "agentMessage") {
      if (method !== "item/completed" || this.#sawAssistantDelta) return;
      const text = stringValue(item?.text);
      if (text) this.callbacks.onEvent({ kind: "assistant-message", text });
      return;
    }

    if (type === "mcpToolCall" || type === "reasoning") return;
    const detail = stringValue(item?.command) ?? stringValue(item?.text);
    this.callbacks.onEvent({
      kind: method === "item/started" ? "tool-started" : "tool-completed",
      toolName: type,
      title: type,
      ...(detail ? { detail } : {}),
      status: method === "item/started" ? "running" : "completed",
    });
  }

  #handleError(params: Record<string, unknown>): void {
    const error = asRecord(params.error);
    this.callbacks.onEvent({
      kind: "error",
      title: "Codex error",
      detail: stringValue(error?.message) ?? JSON.stringify(params),
    });
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
      }, CODEX_REQUEST_TIMEOUT_MS);
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

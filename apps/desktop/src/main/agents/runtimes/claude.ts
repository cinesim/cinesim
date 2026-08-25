import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AgentProviderRuntime,
  AgentRuntimeCallbacks,
  AgentRuntimeLaunchOptions,
} from "./types";
import { asRecord, stringValue } from "./types";

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function lastUsageIteration(usage: Record<string, unknown>): Record<string, unknown> {
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const iteration = asRecord(iterations[index]);
    if (iteration) return iteration;
  }
  return usage;
}

export class ClaudeRuntime implements AgentProviderRuntime {
  #child: ChildProcessWithoutNullStreams | null = null;
  #sawAssistantDelta = false;
  #stopping = false;

  constructor(
    private readonly options: AgentRuntimeLaunchOptions,
    private readonly callbacks: AgentRuntimeCallbacks,
  ) {}

  async start(): Promise<void> {
    if (this.#child) return;
    const mcpConfig = JSON.stringify({
      mcpServers: {
        cinesim: {
          type: "http",
          url: this.options.mcpUrl,
          headers: { Authorization: `Bearer ${this.options.mcpToken}` },
        },
      },
    });
    const arguments_ = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--replay-user-messages",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--allow-dangerously-skip-permissions",
      "--tools",
      "Read,mcp__cinesim__*",
      "--allowedTools",
      "Read,mcp__cinesim__*",
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--append-system-prompt",
      this.options.instructions,
      "--effort",
      this.options.effort,
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(this.options.providerSessionId ? ["--resume", this.options.providerSessionId] : []),
    ];
    const child = spawn(this.options.executablePath, arguments_, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      const detail = line.trim();
      if (detail) this.callbacks.onEvent({ kind: "notice", title: "Claude Code", detail });
    });
    child.once("error", (error) => this.callbacks.onExit(error.message));
    child.once("exit", (code, signal) => {
      this.#child = null;
      if (!this.#stopping)
        this.callbacks.onExit(
          code === 0
            ? undefined
            : `Claude exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        );
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async send(message: string): Promise<void> {
    if (!this.#child) throw new Error("Claude session is not running");
    this.#sawAssistantDelta = false;
    const input = {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: message }] },
    };
    await this.#write(`${JSON.stringify(input)}\n`);
  }

  async interrupt(): Promise<void> {
    if (!this.#child) return;
    this.#child.kill("SIGINT");
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
    const type = stringValue(message.type);
    if (type === "system") {
      const sessionId = stringValue(message.session_id);
      if (sessionId) this.callbacks.onProviderSessionId(sessionId);
      return;
    }
    if (type === "stream_event") {
      this.#handleStreamEvent(asRecord(message.event));
      return;
    }
    if (type === "assistant") {
      const assistantMessage = asRecord(message.message);
      const content = Array.isArray(assistantMessage?.content) ? assistantMessage.content : [];
      for (const blockValue of content) {
        const block = asRecord(blockValue);
        if (!block) continue;
        if (block.type === "text" && !this.#sawAssistantDelta) {
          const text = stringValue(block.text);
          if (text) this.callbacks.onEvent({ kind: "assistant-message", text });
        } else if (block.type === "tool_use") {
          const name = stringValue(block.name) ?? "Tool";
          if (!name.startsWith("mcp__cinesim__"))
            this.callbacks.onEvent({ kind: "tool-started", toolName: name, title: name });
        }
      }
      return;
    }
    if (type === "result") {
      this.#handleUsage(message);
      const subtype = stringValue(message.subtype);
      const failed = subtype !== "success";
      const errors = Array.isArray(message.errors)
        ? message.errors.filter((entry): entry is string => typeof entry === "string").join("\n")
        : undefined;
      this.callbacks.onTurnCompleted(failed ? "failed" : "completed", errors);
    }
  }

  #handleUsage(message: Record<string, unknown>): void {
    const rawUsage = asRecord(message.usage);
    if (!rawUsage) return;
    const usage = lastUsageIteration(rawUsage);
    const uncachedInputTokens = tokenCount(usage.input_tokens);
    const cachedInputTokens =
      tokenCount(usage.cache_creation_input_tokens) + tokenCount(usage.cache_read_input_tokens);
    const inputTokens = uncachedInputTokens + cachedInputTokens;
    const outputTokens = tokenCount(usage.output_tokens);
    const usedTokens = tokenCount(usage.total_tokens) || inputTokens + outputTokens;
    if (usedTokens <= 0) return;
    const modelUsage = asRecord(message.modelUsage);
    const contextWindows = modelUsage
      ? Object.values(modelUsage).map((value) => tokenCount(asRecord(value)?.contextWindow))
      : [];
    const maxTokens = Math.max(0, ...contextWindows);
    const totalProcessedTokens = tokenCount(rawUsage.total_tokens);
    this.callbacks.onTokenUsage({
      usedTokens: maxTokens > 0 ? Math.min(usedTokens, maxTokens) : usedTokens,
      ...(maxTokens > 0 ? { maxTokens } : {}),
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    });
  }

  #handleStreamEvent(event: Record<string, unknown> | null): void {
    if (!event) return;
    if (event.type === "message_start") this.callbacks.onTurnStarted();
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      const text = stringValue(delta?.text) ?? stringValue(delta?.thinking);
      if (!text) return;
      if (delta?.type === "thinking_delta") {
        this.callbacks.onEvent({ kind: "reasoning", text });
      } else {
        this.#sawAssistantDelta = true;
        this.callbacks.onEvent({ kind: "assistant-message", text });
      }
    }
  }

  async #write(contents: string): Promise<void> {
    const child = this.#child;
    if (!child || child.stdin.destroyed) throw new Error("Claude input stream is closed");
    if (child.stdin.write(contents)) return;
    await new Promise<void>((resolve, reject) => {
      child.stdin.once("drain", resolve);
      child.stdin.once("error", reject);
    });
  }
}

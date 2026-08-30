import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentTokenUsage } from "../src/shared/contracts";
import {
  MAX_PROVIDER_LINE_CHARACTERS,
  type AgentRuntimeCallbacks,
  type AgentRuntimeEvent,
} from "../src/main/agents/runtimes/types";
import { ClaudeRuntime } from "../src/main/agents/runtimes/claude";
import { CodexRuntime } from "../src/main/agents/runtimes/codex";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function executable(name: string, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `cinesim-${name}-runtime-`));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}`);
  await chmod(path, 0o755);
  return path;
}

function callbacks(
  completed: () => void,
  events: AgentRuntimeEvent[],
  usages: Array<Omit<AgentTokenUsage, "updatedAt">> = [],
): AgentRuntimeCallbacks {
  return {
    onEvent: (event) => events.push(event),
    onProviderSessionId: () => undefined,
    onTurnStarted: () => undefined,
    onTurnCompleted: () => completed(),
    onTokenUsage: (usage) => usages.push(usage),
    onApproval: async () => false,
    onExit: () => undefined,
  };
}

const launchOptions = (executablePath: string) => ({
  executablePath,
  cwd: tmpdir(),
  model: "test-model",
  effort: "high" as const,
  mcpUrl: "http://127.0.0.1:9876/mcp",
  mcpToken: "test-token",
  instructions: "Use Cinesim tools.",
});

describe("local provider runtimes", () => {
  it("streams a Claude assistant turn from JSON lines", async () => {
    const path = await executable(
      "fake-claude",
      `const readline = require("node:readline");
if (!process.argv.includes("--effort") || !process.argv.includes("high")) process.exit(3);
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-session"}));
readline.createInterface({input:process.stdin}).on("line", () => {
  console.log(JSON.stringify({type:"stream_event",event:{type:"message_start"}}));
  console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"thinking_delta",thinking:"Checking the cut"}}}));
  console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"Done"}}}));
  console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Duplicate final text"},{type:"tool_use",name:"Read"},{type:"tool_use",name:"mcp__cinesim__project_inspect"}]}}));
  console.log(JSON.stringify({type:"result",subtype:"success",session_id:"claude-session",usage:{input_tokens:1200,cache_read_input_tokens:800,output_tokens:200},modelUsage:{"test-model":{contextWindow:200000}}}));
});`,
    );
    const events: AgentRuntimeEvent[] = [];
    const usages: Array<Omit<AgentTokenUsage, "updatedAt">> = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sessionIds: string[] = [];
    let turnsStarted = 0;
    const runtimeCallbacks = callbacks(finish, events, usages);
    runtimeCallbacks.onProviderSessionId = (id) => sessionIds.push(id);
    runtimeCallbacks.onTurnStarted = () => {
      turnsStarted += 1;
    };
    const runtime = new ClaudeRuntime(launchOptions(path), runtimeCallbacks);
    await runtime.start();
    await runtime.send("Inspect the timeline");
    await completed;
    expect(sessionIds).toContain("claude-session");
    expect(turnsStarted).toBe(1);
    expect(events).toContainEqual({ kind: "reasoning", text: "Checking the cut" });
    expect(events).toContainEqual({ kind: "assistant-message", text: "Done" });
    expect(events).not.toContainEqual({ kind: "assistant-message", text: "Duplicate final text" });
    expect(events).toContainEqual({
      kind: "tool-started",
      toolName: "Read",
      title: "Read",
    });
    expect(events.some((event) => event.toolName?.startsWith("mcp__cinesim__"))).toBe(false);
    expect(usages).toContainEqual({
      usedTokens: 2_200,
      maxTokens: 200_000,
      inputTokens: 2_000,
      cachedInputTokens: 800,
      outputTokens: 200,
    });
    await runtime.stop();
  });

  it("rejects oversized Claude output and reports malformed lines and failed results", async () => {
    const path = await executable(
      "fake-claude-errors",
      `const readline = require("node:readline");
const send = value => console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on("line", () => {
  console.log("unstructured provider notice");
  console.log("x".repeat(${MAX_PROVIDER_LINE_CHARACTERS + 1}));
  send({type:"assistant",message:{content:[{type:"text",text:"Fallback response"}]}});
  send({type:"result",subtype:"error",errors:["First failure",42,"Second failure"]});
});`,
    );
    const events: AgentRuntimeEvent[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const completions: Array<{ status: string; detail?: string }> = [];
    const runtimeCallbacks = callbacks(finish, events);
    runtimeCallbacks.onTurnCompleted = (status, detail) => {
      completions.push({ status, ...(detail ? { detail } : {}) });
      finish();
    };
    const runtime = new ClaudeRuntime(launchOptions(path), runtimeCallbacks);

    await runtime.start();
    await runtime.send("Return a fallback response");
    await completed;

    expect(events).toContainEqual({ kind: "notice", detail: "unstructured provider notice" });
    expect(events).toContainEqual({
      kind: "error",
      title: "Claude Code output rejected",
      detail: "The provider emitted a message beyond the runtime size limit.",
    });
    expect(events).toContainEqual({ kind: "assistant-message", text: "Fallback response" });
    expect(completions).toEqual([{ status: "failed", detail: "First failure\nSecond failure" }]);
    await runtime.stop();
  });

  it("initializes Codex app-server and streams a completed turn", async () => {
    const path = await executable(
      "fake-codex",
      `const readline = require("node:readline");
const send = value => console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({id:request.id,result:{}});
  if (request.method === "thread/start") {
    send({id:request.id,result:{thread:{id:"codex-thread"}}});
    send({method:"thread/started",params:{thread:{id:"codex-thread"}}});
  }
  if (request.method === "turn/start") {
    if (request.params.effort !== "high") process.exit(3);
    send({id:request.id,result:{turn:{id:"codex-turn"}}});
    send({method:"turn/started",params:{turn:{id:"codex-turn"}}});
    send({id:"approval-1",method:"item/commandExecution/requestApproval",params:{command:"echo test"}});
  }
  if (request.id === "approval-1" && request.result?.decision === "decline") {
    send({method:"item/reasoning/summaryTextDelta",params:{delta:"Checking the timeline."}});
    send({method:"item/started",params:{item:{type:"commandExecution",command:"echo test"}}});
    send({method:"item/completed",params:{item:{type:"commandExecution",command:"echo test"}}});
    send({method:"item/agentMessage/delta",params:{delta:"Changed the timeline."}});
    send({method:"thread/tokenUsage/updated",params:{threadId:"codex-thread",turnId:"codex-turn",tokenUsage:{last:{inputTokens:3000,cachedInputTokens:2000,outputTokens:400,reasoningOutputTokens:100,totalTokens:3500},total:{inputTokens:5000,cachedInputTokens:3000,outputTokens:600,reasoningOutputTokens:200,totalTokens:5800},modelContextWindow:258400}}});
    send({method:"error",params:{error:{message:"Nonfatal provider notice"}}});
    send({method:"turn/completed",params:{turn:{id:"codex-turn",status:"completed"}}});
  }
});`,
    );
    const events: AgentRuntimeEvent[] = [];
    const usages: Array<Omit<AgentTokenUsage, "updatedAt">> = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let approvalRequested = false;
    const providerSessionIds: string[] = [];
    const startedTurnIds: Array<string | undefined> = [];
    const runtimeCallbacks = callbacks(finish, events, usages);
    runtimeCallbacks.onProviderSessionId = (id) => providerSessionIds.push(id);
    runtimeCallbacks.onTurnStarted = (id) => startedTurnIds.push(id);
    runtimeCallbacks.onApproval = async () => {
      approvalRequested = true;
      return false;
    };
    const runtime = new CodexRuntime(launchOptions(path), runtimeCallbacks);
    await runtime.start();
    await runtime.send("Move the clip");
    await completed;
    expect(providerSessionIds).toContain("codex-thread");
    expect(startedTurnIds).toContain("codex-turn");
    expect(events).toContainEqual({ kind: "reasoning", text: "Checking the timeline." });
    expect(events).toContainEqual({
      kind: "tool-started",
      toolName: "commandExecution",
      title: "commandExecution",
      detail: "echo test",
      status: "running",
    });
    expect(events).toContainEqual({
      kind: "tool-completed",
      toolName: "commandExecution",
      title: "commandExecution",
      detail: "echo test",
      status: "completed",
    });
    expect(events).toContainEqual({ kind: "assistant-message", text: "Changed the timeline." });
    expect(events).toContainEqual({
      kind: "error",
      title: "Codex error",
      detail: "Nonfatal provider notice",
    });
    expect(approvalRequested).toBe(true);
    expect(usages).toContainEqual({
      usedTokens: 3_500,
      maxTokens: 258_400,
      inputTokens: 3_000,
      cachedInputTokens: 2_000,
      outputTokens: 400,
      reasoningOutputTokens: 100,
      totalProcessedTokens: 5_800,
    });
    await runtime.stop();
  });

  it("uses the completed Codex message when no assistant delta arrived", async () => {
    const path = await executable(
      "fake-codex-fallback",
      `const readline = require("node:readline");
const send = value => console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({id:request.id,result:{}});
  if (request.method === "thread/start") send({id:request.id,result:{thread:{id:"codex-thread"}}});
  if (request.method === "turn/start") {
    send({id:request.id,result:{turn:{id:"codex-turn"}}});
    send({method:"item/completed",params:{item:{type:"agentMessage",text:"Completed response."}}});
    send({method:"turn/completed",params:{turn:{id:"codex-turn",status:"failed",error:{message:"Provider failed"}}}});
  }
});`,
    );
    const events: AgentRuntimeEvent[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const completions: Array<{ status: string; detail?: string }> = [];
    const runtimeCallbacks = callbacks(finish, events);
    runtimeCallbacks.onTurnCompleted = (status, detail) => {
      completions.push({ status, ...(detail ? { detail } : {}) });
      finish();
    };
    const runtime = new CodexRuntime(launchOptions(path), runtimeCallbacks);

    await runtime.start();
    await runtime.send("Return a complete message");
    await completed;

    expect(events).toContainEqual({ kind: "assistant-message", text: "Completed response." });
    expect(completions).toEqual([{ status: "failed", detail: "Provider failed" }]);
    await runtime.stop();
  });
});

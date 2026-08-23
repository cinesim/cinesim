import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimeCallbacks, AgentRuntimeEvent } from "../src/main/agent-runtime";
import { ClaudeRuntime } from "../src/main/claude-runtime";
import { CodexRuntime } from "../src/main/codex-runtime";

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

function callbacks(completed: () => void, events: AgentRuntimeEvent[]): AgentRuntimeCallbacks {
  return {
    onEvent: (event) => events.push(event),
    onProviderSessionId: () => undefined,
    onTurnStarted: () => undefined,
    onTurnCompleted: () => completed(),
    onApproval: async () => false,
    onExit: () => undefined,
  };
}

const launchOptions = (executablePath: string) => ({
  executablePath,
  cwd: tmpdir(),
  model: "test-model",
  mcpUrl: "http://127.0.0.1:9876/mcp",
  mcpToken: "test-token",
  instructions: "Use Cinesim tools.",
});

describe("local provider runtimes", () => {
  it("streams a Claude assistant turn from JSON lines", async () => {
    const path = await executable(
      "fake-claude",
      `const readline = require("node:readline");
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-session"}));
readline.createInterface({input:process.stdin}).on("line", () => {
  console.log(JSON.stringify({type:"stream_event",event:{type:"message_start"}}));
  console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"Done"}}}));
  console.log(JSON.stringify({type:"result",subtype:"success",session_id:"claude-session"}));
});`,
    );
    const events: AgentRuntimeEvent[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runtime = new ClaudeRuntime(launchOptions(path), callbacks(finish, events));
    await runtime.start();
    await runtime.send("Inspect the timeline");
    await completed;
    expect(events).toContainEqual({ kind: "assistant-message", text: "Done" });
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
  if (request.method === "thread/start") send({id:request.id,result:{thread:{id:"codex-thread"}}});
  if (request.method === "turn/start") {
    send({id:request.id,result:{turn:{id:"codex-turn"}}});
    send({id:"approval-1",method:"item/commandExecution/requestApproval",params:{command:"echo test"}});
  }
  if (request.id === "approval-1" && request.result?.decision === "decline") {
    send({method:"item/agentMessage/delta",params:{delta:"Changed the timeline."}});
    send({method:"turn/completed",params:{turn:{id:"codex-turn",status:"completed"}}});
  }
});`,
    );
    const events: AgentRuntimeEvent[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let approvalRequested = false;
    const runtimeCallbacks = callbacks(finish, events);
    runtimeCallbacks.onApproval = async () => {
      approvalRequested = true;
      return false;
    };
    const runtime = new CodexRuntime(launchOptions(path), runtimeCallbacks);
    await runtime.start();
    await runtime.send("Move the clip");
    await completed;
    expect(events).toContainEqual({ kind: "assistant-message", text: "Changed the timeline." });
    expect(approvalRequested).toBe(true);
    await runtime.stop();
  });
});

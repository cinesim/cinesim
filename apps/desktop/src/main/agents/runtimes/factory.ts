import type { AgentProviderKind } from "../../../shared/contracts";
import { ClaudeRuntime } from "./claude";
import { CodexRuntime } from "./codex";
import type {
  AgentProviderRuntime,
  AgentRuntimeCallbacks,
  AgentRuntimeLaunchOptions,
} from "./types";

export function createAgentRuntime(
  provider: AgentProviderKind,
  options: AgentRuntimeLaunchOptions,
  callbacks: AgentRuntimeCallbacks,
): AgentProviderRuntime {
  return provider === "claude"
    ? new ClaudeRuntime(options, callbacks)
    : new CodexRuntime(options, callbacks);
}

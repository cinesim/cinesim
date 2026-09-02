import { describe, expect, it } from "vite-plus/test";
import {
  mergeClaudeInstructions,
  mergeClaudeMcpConfig,
  mergeCodexMcpConfig,
  mergeProjectAgents,
  projectCustomInstructions,
  renderManagedProjectGuidance,
} from "../src";

describe("managed project agent integration", () => {
  it("updates one managed guidance block while preserving custom instructions", () => {
    const first = mergeProjectAgents(null, "Keep interview pauses.");
    const second = mergeProjectAgents(first);
    expect(second).toBe(first);
    expect(second).toContain("assets.toml");
    expect(second).toContain("Edit canonical files directly");
    expect(second).toContain("Keep interview pauses.");
    expect(projectCustomInstructions(second)).toBe("Keep interview pauses.");
    expect(renderManagedProjectGuidance()).toContain("cinesim:managed-guidance:v1:start");
  });

  it("adds provider integration without replacing unrelated configuration", () => {
    expect(mergeClaudeInstructions("# Claude custom\n")).toBe("@AGENTS.md\n\n# Claude custom\n");
    const claude = JSON.parse(
      mergeClaudeMcpConfig(
        JSON.stringify({ mcpServers: { research: { command: "research" } }, keep: true }),
      ),
    ) as Record<string, unknown>;
    expect(claude).toMatchObject({
      keep: true,
      mcpServers: {
        research: { command: "research" },
        cinesim: { command: "cinesim", args: ["mcp", "--project", "."] },
      },
    });
    const codex = mergeCodexMcpConfig('[mcp_servers.research]\ncommand = "research"\n');
    expect(codex).toContain("[mcp_servers.research]");
    expect(codex).toContain("[mcp_servers.cinesim]");
    expect(mergeCodexMcpConfig(codex)).toBe(codex);
  });
});

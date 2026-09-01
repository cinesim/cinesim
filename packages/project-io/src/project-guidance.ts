import { parse, stringify } from "smol-toml";

export const CINESIM_GUIDANCE_VERSION = 1;
const MANAGED_START = `<!-- cinesim:managed-guidance:v${CINESIM_GUIDANCE_VERSION}:start -->`;
const MANAGED_END = "<!-- cinesim:managed-guidance:end -->";

const MANAGED_GUIDANCE = `${MANAGED_START}
# Cinesim project guidance

- Canonical state is \`cinesim.toml\`, \`assets.toml\`, and reachable \`.js\`/\`.jsx\` source modules.
- Edit canonical files directly. A complete generation becomes active only after it parses, binds, validates, and compiles successfully.
- Inspect compiler diagnostics after edits. Invalid files stay on disk but never replace the last accepted program used for playback.
- Timeline structure lives in source. Use lowercase Cinesim built-ins, capitalized user components, stable IDs, and integer microsecond times.
- Reference imported media with \`asset("asset_id")\` IDs declared in \`assets.toml\`; never move, overwrite, or delete source media.
- Use Cinesim MCP for inspection, perception, compiler/language help, and disposable services—not canonical editing.
- Everything under \`.video/\` is disposable derived/runtime data and does not belong in canonical history.
${MANAGED_END}`;

function customSuffix(existing: string): string {
  const managedEnd = existing.indexOf(MANAGED_END);
  if (managedEnd >= 0)
    return existing
      .slice(managedEnd + MANAGED_END.length)
      .trim()
      .replace(/^# Custom instructions\s*/u, "");
  const legacyMarker = "Add creative direction below this line.";
  const marker = existing.indexOf(legacyMarker);
  return marker >= 0 ? existing.slice(marker + legacyMarker.length).trim() : existing.trim();
}

export function renderProjectAgents(customInstructions = ""): string {
  const custom = customInstructions.trim();
  return `${MANAGED_GUIDANCE}\n\n# Custom instructions\n${custom ? `\n${custom}\n` : ""}`;
}

export function mergeProjectAgents(existing: string | null, defaultCustom = ""): string {
  return renderProjectAgents(existing === null ? defaultCustom : customSuffix(existing));
}

export function mergeClaudeInstructions(existing: string | null): string {
  const importLine = "@AGENTS.md";
  if (existing === null || existing.trim() === "") return `${importLine}\n`;
  if (existing.split(/\r?\n/u).some((line) => line.trim() === importLine)) return existing;
  return `${importLine}\n\n${existing.trim()}\n`;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function mergeClaudeMcpConfig(existing: string | null): string {
  const root = existing === null ? {} : objectRecord(JSON.parse(existing) as unknown);
  const mcpServers = objectRecord(root.mcpServers);
  return `${JSON.stringify(
    {
      ...root,
      mcpServers: {
        ...mcpServers,
        cinesim: { type: "stdio", command: "cinesim", args: ["mcp", "--project", "."] },
      },
    },
    null,
    2,
  )}\n`;
}

function tableRange(source: string, header: string): { start: number; end: number } | null {
  const escaped = header.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\[${escaped}\\][ \\t]*(?:\\r?\\n|$)`, "mu").exec(source);
  if (!match || match.index === undefined) return null;
  const next = /^\[[^\r\n]+\][ \t]*(?:\r?\n|$)/gmu;
  next.lastIndex = match.index + match[0].length;
  return { start: match.index, end: next.exec(source)?.index ?? source.length };
}

export function mergeCodexMcpConfig(existing: string | null): string {
  if (existing !== null) parse(existing);
  const block = `${stringify({
    mcp_servers: {
      cinesim: { command: "cinesim", args: ["mcp", "--project", "."] },
    },
  })}\n`;
  if (existing === null || existing.trim() === "") return block;
  const range = tableRange(existing, "mcp_servers.cinesim");
  if (!range) return `${existing.trimEnd()}\n\n${block}`;
  return `${existing.slice(0, range.start)}${block}${existing.slice(range.end)}`;
}

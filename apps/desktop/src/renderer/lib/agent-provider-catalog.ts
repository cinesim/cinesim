import type { AgentEffort, AgentProviderKind } from "../../shared/contracts";

export const AGENT_PROVIDER_KINDS: readonly AgentProviderKind[] = ["claude", "codex"];

export const AGENT_PROVIDER_CATALOG: Record<
  AgentProviderKind,
  {
    label: string;
    models: ReadonlyArray<{ value: string; label: string }>;
  }
> = {
  claude: {
    label: "Claude Code",
    models: [
      { value: "sonnet", label: "Sonnet · latest" },
      { value: "opus", label: "Opus · latest" },
      { value: "fable", label: "Fable · latest" },
      { value: "haiku", label: "Haiku · latest" },
    ],
  },
  codex: {
    label: "Codex",
    models: [
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-5.4", label: "GPT-5.4" },
    ],
  },
};

export const AGENT_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function providerLabel(provider: AgentProviderKind): string {
  return AGENT_PROVIDER_CATALOG[provider].label;
}

export function effortLabel(effort: AgentEffort): string {
  if (effort === "xhigh") return "Extra high";
  if (effort === "max") return "Maximum";
  return effort[0]!.toUpperCase() + effort.slice(1);
}

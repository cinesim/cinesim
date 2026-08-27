import type { AgentProjectSnapshot, AgentProviderStatus, AgentSettings } from "../../shared/api";

const projectSnapshots = new Map<string, AgentProjectSnapshot>();
let settings: AgentSettings | null = null;
let providers: AgentProviderStatus[] = [];

export function cachedAgentProject(projectDirectory: string): AgentProjectSnapshot | null {
  return projectSnapshots.get(projectDirectory) ?? null;
}

export function cacheAgentProject(snapshot: AgentProjectSnapshot): void {
  projectSnapshots.set(snapshot.projectDirectory, snapshot);
}

export function cachedAgentSettings(): AgentSettings | null {
  return settings;
}

export function cacheAgentSettings(next: AgentSettings): void {
  settings = next;
}

export function cachedAgentProviders(): AgentProviderStatus[] {
  return providers;
}

export function cacheAgentProviders(next: AgentProviderStatus[]): void {
  providers = next;
}

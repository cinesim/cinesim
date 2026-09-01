import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentEffort,
  AgentProviderKind,
  AgentSettings,
  AgentSettingsUpdate,
} from "../../shared/contracts";
import {
  inspectAgentExecutable,
  isAgentExecutableIdentity,
  verifyAgentExecutable,
} from "./executable-trust";
import type { AgentExecutableIdentity } from "./executable-trust";

const DEFAULT_SETTINGS: AgentSettings = {
  version: 1,
  defaultProvider: "claude",
  projectInstructions: "",
  providers: {
    claude: { executablePath: "", model: "sonnet", effort: "high", permissionMode: "supervised" },
    codex: {
      executablePath: "",
      model: "gpt-5.6-sol",
      effort: "high",
      permissionMode: "supervised",
    },
  },
};

interface PersistedAgentSettings {
  version: 2;
  settings: AgentSettings;
  executableIdentities: Record<AgentProviderKind, AgentExecutableIdentity | null>;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isProvider(value: unknown): value is AgentProviderKind {
  return value === "claude" || value === "codex";
}

function isEffort(value: unknown): value is AgentEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function parseSettings(value: unknown): AgentSettings {
  const candidate = objectRecord(value);
  if (Object.keys(candidate).length === 0) return structuredClone(DEFAULT_SETTINGS);
  const providers = objectRecord(candidate.providers);
  return {
    version: 1,
    defaultProvider: isProvider(candidate.defaultProvider) ? candidate.defaultProvider : "claude",
    projectInstructions:
      typeof candidate.projectInstructions === "string"
        ? candidate.projectInstructions.slice(0, 20_000)
        : "",
    providers: {
      claude: parseProviderSettings("claude", providers.claude),
      codex: parseProviderSettings("codex", providers.codex),
    },
  };
}

function parseProviderSettings(provider: AgentProviderKind, value: unknown) {
  const raw = objectRecord(value);
  const defaults = DEFAULT_SETTINGS.providers[provider];
  return {
    executablePath: typeof raw.executablePath === "string" ? raw.executablePath : "",
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model : defaults.model,
    effort: isEffort(raw.effort) ? raw.effort : defaults.effort,
    permissionMode: raw.permissionMode === "auto-edit" ? "auto-edit" : "supervised",
  } as const;
}

export class AgentSettingsStore {
  #settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  #executableIdentities: Record<AgentProviderKind, AgentExecutableIdentity | null> = {
    claude: null,
    codex: null,
  };
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.#loadParsedSettings(parsed);
    } catch {
      this.#reset();
    }
  }

  #loadParsedSettings(parsed: unknown): void {
    const record = objectRecord(parsed);
    if (record.version !== 2) {
      this.#reset();
      return;
    }

    this.#settings = parseSettings(record.settings);
    const identities = objectRecord(record.executableIdentities);
    for (const provider of ["claude", "codex"] as const)
      this.#loadExecutableIdentity(provider, identities[provider]);
  }

  #loadExecutableIdentity(provider: AgentProviderKind, value: unknown): void {
    const identity = isAgentExecutableIdentity(value) ? value : null;
    this.#executableIdentities[provider] = identity;
    if (!identity) this.#settings.providers[provider].executablePath = "";
  }

  #reset(): void {
    this.#settings = structuredClone(DEFAULT_SETTINGS);
    this.#executableIdentities = { claude: null, codex: null };
  }

  snapshot(): AgentSettings {
    return structuredClone(this.#settings);
  }

  async update(update: AgentSettingsUpdate): Promise<AgentSettings> {
    if (update.defaultProvider) this.#settings.defaultProvider = update.defaultProvider;
    if (update.projectInstructions !== undefined)
      this.#settings.projectInstructions = update.projectInstructions.slice(0, 20_000);
    if (update.provider) {
      const current = this.#settings.providers[update.provider];
      this.#settings.providers[update.provider] = {
        executablePath: current.executablePath,
        model: update.model?.trim() || current.model,
        effort: update.effort ?? current.effort,
        permissionMode: update.permissionMode ?? current.permissionMode,
      };
    }
    await this.#queueSave();
    return this.snapshot();
  }

  async trustExecutable(provider: AgentProviderKind, path: string): Promise<AgentSettings> {
    const identity = await inspectAgentExecutable(path);
    this.#executableIdentities[provider] = identity;
    this.#settings.providers[provider].executablePath = identity.path;
    await this.#queueSave();
    return this.snapshot();
  }

  async requireTrustedExecutable(provider: AgentProviderKind): Promise<string> {
    const identity = this.#executableIdentities[provider];
    if (!identity)
      throw new Error(`${provider === "claude" ? "Claude Code" : "Codex"} is not configured`);
    return verifyAgentExecutable(identity);
  }

  async #queueSave(): Promise<void> {
    const contents = `${JSON.stringify(
      {
        version: 2,
        settings: this.#settings,
        executableIdentities: this.#executableIdentities,
      } satisfies PersistedAgentSettings,
      null,
      2,
    )}\n`;
    const write = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const temporaryPath = `${this.path}.tmp`;
        await writeFile(temporaryPath, contents, "utf8");
        await rename(temporaryPath, this.path);
      });
    this.#writeQueue = write;
    await write;
  }
}

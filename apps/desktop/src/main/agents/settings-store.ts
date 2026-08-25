import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentEffort,
  AgentProviderKind,
  AgentSettings,
  AgentSettingsUpdate,
} from "../../shared/api";

const DEFAULT_SETTINGS: AgentSettings = {
  version: 1,
  defaultProvider: "claude",
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
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return structuredClone(DEFAULT_SETTINGS);
  const candidate = value as Record<string, unknown>;
  const providers =
    typeof candidate.providers === "object" && candidate.providers !== null
      ? (candidate.providers as Record<string, unknown>)
      : {};
  const parseProvider = (provider: AgentProviderKind) => {
    const raw =
      typeof providers[provider] === "object" && providers[provider] !== null
        ? (providers[provider] as Record<string, unknown>)
        : {};
    return {
      executablePath: typeof raw.executablePath === "string" ? raw.executablePath : "",
      model:
        typeof raw.model === "string" && raw.model.trim().length > 0
          ? raw.model
          : DEFAULT_SETTINGS.providers[provider].model,
      effort: isEffort(raw.effort) ? raw.effort : DEFAULT_SETTINGS.providers[provider].effort,
      permissionMode: raw.permissionMode === "auto-edit" ? "auto-edit" : "supervised",
    } as const;
  };
  return {
    version: 1,
    defaultProvider: isProvider(candidate.defaultProvider) ? candidate.defaultProvider : "claude",
    providers: { claude: parseProvider("claude"), codex: parseProvider("codex") },
  };
}

export class AgentSettingsStore {
  #settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.#settings = parseSettings(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch {
      this.#settings = structuredClone(DEFAULT_SETTINGS);
    }
  }

  snapshot(): AgentSettings {
    return structuredClone(this.#settings);
  }

  async update(update: AgentSettingsUpdate): Promise<AgentSettings> {
    if (update.defaultProvider) this.#settings.defaultProvider = update.defaultProvider;
    if (update.provider) {
      const current = this.#settings.providers[update.provider];
      this.#settings.providers[update.provider] = {
        executablePath: update.executablePath ?? current.executablePath,
        model: update.model?.trim() || current.model,
        effort: update.effort ?? current.effort,
        permissionMode: update.permissionMode ?? current.permissionMode,
      };
    }
    await this.#queueSave();
    return this.snapshot();
  }

  async #queueSave(): Promise<void> {
    const contents = `${JSON.stringify(this.#settings, null, 2)}\n`;
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

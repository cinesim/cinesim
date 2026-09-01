import { readFile, rename, writeFile } from "node:fs/promises";
import type { SourceProjectRepository, SourceProjectSnapshot } from "./source-project-repository";

export interface AcceptedProjectState {
  generation: string;
  manifestSource: string;
  assetManifestSource: string;
  sources: Record<string, string>;
}

interface HistoryIndex {
  version: 1;
  entries: string[];
  index: number;
}

const HISTORY_DIRECTORY = ".video/history";
const STATE_DIRECTORY = `${HISTORY_DIRECTORY}/states`;
const INDEX_PATH = `${HISTORY_DIRECTORY}/journal.json`;
const GENERATION_PATTERN = /^[a-f0-9]{64}$/u;

function stateFromSnapshot(snapshot: SourceProjectSnapshot): AcceptedProjectState {
  return {
    generation: snapshot.generation,
    manifestSource: snapshot.manifestSource,
    assetManifestSource: snapshot.assetManifestSource,
    sources: Object.fromEntries(
      Object.entries(snapshot.sources).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function parseIndex(value: unknown): HistoryIndex | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) return null;
  const entries = record.entries.filter(
    (entry): entry is string => typeof entry === "string" && GENERATION_PATTERN.test(entry),
  );
  if (entries.length !== record.entries.length) return null;
  if (
    typeof record.index !== "number" ||
    !Number.isSafeInteger(record.index) ||
    record.index < 0 ||
    record.index >= entries.length
  ) {
    return null;
  }
  return { version: 1, entries, index: record.index };
}

function parseState(value: unknown, generation: string): AcceptedProjectState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid accepted project history state.");
  const record = value as Record<string, unknown>;
  if (
    record.generation !== generation ||
    typeof record.manifestSource !== "string" ||
    typeof record.assetManifestSource !== "string" ||
    record.sources === null ||
    typeof record.sources !== "object" ||
    Array.isArray(record.sources)
  ) {
    throw new Error("Invalid accepted project history state.");
  }
  const sources = Object.fromEntries(
    Object.entries(record.sources).map(([path, source]) => {
      if (typeof source !== "string") throw new Error("Invalid accepted source history state.");
      return [path, source];
    }),
  );
  return {
    generation,
    manifestSource: record.manifestSource,
    assetManifestSource: record.assetManifestSource,
    sources,
  };
}

export class AcceptedProjectHistory {
  private constructor(
    private readonly repository: SourceProjectRepository,
    private readonly history: HistoryIndex,
    private readonly limit: number,
  ) {}

  static async open(
    repository: SourceProjectRepository,
    current: SourceProjectSnapshot,
    limit = 100,
  ): Promise<AcceptedProjectHistory> {
    await repository.paths.ensureDirectory(STATE_DIRECTORY);
    const loaded = await readFile(repository.paths.derived(INDEX_PATH), "utf8")
      .then((source) => parseIndex(JSON.parse(source) as unknown))
      .catch(() => null);
    const history =
      loaded?.entries[loaded.index] === current.generation
        ? loaded
        : { version: 1 as const, entries: [current.generation], index: 0 };
    const result = new AcceptedProjectHistory(repository, history, limit);
    await result.#writeState(current);
    await result.#writeIndex();
    return result;
  }

  get canUndo(): boolean {
    return this.history.index > 0;
  }

  get canRedo(): boolean {
    return this.history.index < this.history.entries.length - 1;
  }

  async append(snapshot: SourceProjectSnapshot): Promise<void> {
    if (this.history.entries[this.history.index] === snapshot.generation) return;
    await this.#writeState(snapshot);
    this.history.entries.splice(this.history.index + 1);
    this.history.entries.push(snapshot.generation);
    if (this.history.entries.length > this.limit) this.history.entries.shift();
    this.history.index = this.history.entries.length - 1;
    await this.#writeIndex();
  }

  async destination(direction: "undo" | "redo"): Promise<AcceptedProjectState> {
    const index = this.history.index + (direction === "undo" ? -1 : 1);
    const generation = this.history.entries[index];
    if (!generation) throw new Error(`Nothing to ${direction}.`);
    const source = await readFile(this.#statePath(generation), "utf8");
    return parseState(JSON.parse(source) as unknown, generation);
  }

  async acceptMove(direction: "undo" | "redo", snapshot: SourceProjectSnapshot): Promise<void> {
    const index = this.history.index + (direction === "undo" ? -1 : 1);
    if (this.history.entries[index] !== snapshot.generation)
      throw new Error(`Restored ${direction} state did not match its accepted generation hash.`);
    this.history.index = index;
    await this.#writeIndex();
  }

  async #writeState(snapshot: SourceProjectSnapshot): Promise<void> {
    const path = this.#statePath(snapshot.generation);
    await writeFile(path, `${JSON.stringify(stateFromSnapshot(snapshot))}\n`, {
      encoding: "utf8",
      flag: "wx",
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }

  async #writeIndex(): Promise<void> {
    const path = this.repository.paths.derived(INDEX_PATH);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.history)}\n`, "utf8");
    await rename(temporary, path);
  }

  #statePath(generation: string): string {
    if (!GENERATION_PATTERN.test(generation)) throw new Error("Invalid project generation hash.");
    return this.repository.paths.derived(`${STATE_DIRECTORY}/${generation}.json`);
  }
}

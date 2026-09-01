import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { AssetId, Project } from "@cinesim/core";
import { ProjectPaths } from "./project-paths";
import {
  projectSourceFingerprintsEqual,
  type ProjectSourceFingerprint,
} from "./source-fingerprint";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_OBSERVATIONS = 10_000;
export const VISUAL_INDEX_VERSION = 1;
export const VISUAL_INDEX_GENERATOR_VERSION = "cinesim-visual-index-v1";

export interface VisualIndexRange {
  sourceInUs: number;
  sourceOutUs: number;
}

export interface VisualIndexObservation extends VisualIndexRange {
  id: string;
  description: string;
  people?: string[];
  setting?: string;
  shotType?: string;
  tags?: string[];
  continuity?: string;
  confidence?: number;
  provenance?: string;
}

export interface VisualIndexArtifact {
  version: 1;
  assetId: AssetId;
  sourceFingerprint: ProjectSourceFingerprint;
  generatorVersion: string;
  options: Record<string, boolean | number | string | null>;
  coverage: VisualIndexRange[];
  observations: VisualIndexObservation[];
}

export interface VisualIndexAssetStatus {
  assetId: AssetId;
  state: "missing" | "current" | "stale";
  observationCount: number;
  coverage: VisualIndexRange[];
  generatorVersion?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value.trim();
}

function safeTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function parseRange(value: unknown, label: string): VisualIndexRange {
  const input = record(value, label);
  const sourceInUs = safeTime(input.sourceInUs, `${label}.sourceInUs`);
  const sourceOutUs = safeTime(input.sourceOutUs, `${label}.sourceOutUs`);
  if (sourceOutUs <= sourceInUs) throw new Error(`${label} must have a positive duration`);
  return { sourceInUs, sourceOutUs };
}

function optionalStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50)
    throw new Error(`${label} must contain at most 50 strings`);
  return [...new Set(value.map((item) => boundedString(item, label, 200)))].sort();
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximum);
}

export function parseVisualIndexObservation(value: unknown): VisualIndexObservation {
  const input = record(value, "observation");
  const range = parseRange(input, "observation");
  const id = boundedString(input.id, "observation.id", 128);
  if (!/^observation_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id))
    throw new Error("observation.id must use the observation_ prefix");
  const confidence = input.confidence;
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  )
    throw new Error("observation.confidence must be between zero and one");
  const people = optionalStrings(input.people, "observation.people");
  const setting = optionalString(input.setting, "observation.setting", 500);
  const shotType = optionalString(input.shotType, "observation.shotType", 100);
  const tags = optionalStrings(input.tags, "observation.tags");
  const continuity = optionalString(input.continuity, "observation.continuity", 1_000);
  const provenance = optionalString(input.provenance, "observation.provenance", 200);
  return {
    id,
    ...range,
    description: boundedString(input.description, "observation.description", 2_000),
    ...(people ? { people } : {}),
    ...(setting ? { setting } : {}),
    ...(shotType ? { shotType } : {}),
    ...(tags ? { tags } : {}),
    ...(continuity ? { continuity } : {}),
    ...(confidence === undefined ? {} : { confidence }),
    ...(provenance ? { provenance } : {}),
  };
}

function parseFingerprint(value: unknown): ProjectSourceFingerprint {
  const input = record(value, "sourceFingerprint");
  const size = Number(input.size);
  const mtimeMs = Number(input.mtimeMs);
  const edgeHash = typeof input.edgeHash === "string" ? input.edgeHash : "";
  if (
    !Number.isFinite(size) ||
    !Number.isFinite(mtimeMs) ||
    !/^(?:[a-f0-9]{64}|missing)$/u.test(edgeHash)
  )
    throw new Error("sourceFingerprint is invalid");
  return { size, mtimeMs, edgeHash };
}

function parseOptions(value: unknown): VisualIndexArtifact["options"] {
  const input = record(value, "options");
  const entries = Object.entries(input);
  if (entries.length > 50) throw new Error("Visual-index options contain too many entries");
  const output: VisualIndexArtifact["options"] = {};
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(key))
      throw new Error("Visual-index option key is invalid");
    if (
      item !== null &&
      (!["boolean", "number", "string"].includes(typeof item) ||
        (typeof item === "number" && !Number.isFinite(item)))
    )
      throw new Error(`Visual-index option ${key} has an unsupported value`);
    output[key] = item as boolean | number | string | null;
  }
  return output;
}

export function parseVisualIndexArtifact(value: unknown): VisualIndexArtifact {
  const input = record(value, "visual index");
  if (input.version !== VISUAL_INDEX_VERSION) throw new Error("Unsupported visual-index version");
  const assetId = boundedString(input.assetId, "assetId", 128) as AssetId;
  if (!/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(assetId)) throw new Error("assetId is invalid");
  if (!Array.isArray(input.coverage) || !Array.isArray(input.observations))
    throw new Error("Visual index coverage and observations must be arrays");
  if (input.observations.length > MAX_OBSERVATIONS)
    throw new Error("Visual index has too many observations");
  return normalizeVisualIndex({
    version: VISUAL_INDEX_VERSION,
    assetId,
    sourceFingerprint: parseFingerprint(input.sourceFingerprint),
    generatorVersion: boundedString(input.generatorVersion, "generatorVersion", 200),
    options: parseOptions(input.options),
    coverage: input.coverage.map((range, index) => parseRange(range, `coverage[${index}]`)),
    observations: input.observations.map(parseVisualIndexObservation),
  });
}

function mergeCoverage(ranges: readonly VisualIndexRange[]): VisualIndexRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.sourceInUs - right.sourceInUs || left.sourceOutUs - right.sourceOutUs,
  );
  const merged: VisualIndexRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.sourceInUs > previous.sourceOutUs) merged.push({ ...range });
    else previous.sourceOutUs = Math.max(previous.sourceOutUs, range.sourceOutUs);
  }
  return merged;
}

function normalizeVisualIndex(artifact: VisualIndexArtifact): VisualIndexArtifact {
  const observations = [...artifact.observations].sort(
    (left, right) =>
      left.sourceInUs - right.sourceInUs ||
      left.sourceOutUs - right.sourceOutUs ||
      left.id.localeCompare(right.id),
  );
  if (new Set(observations.map(({ id }) => id)).size !== observations.length)
    throw new Error("Visual-index observation IDs must be unique");
  return {
    ...artifact,
    options: parseOptions(artifact.options),
    coverage: mergeCoverage(artifact.coverage),
    observations,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class VisualIndexStore {
  #directory: string | null = null;
  #project: Project | null = null;

  constructor(
    private readonly fingerprintForAsset: (assetId: AssetId) => Promise<ProjectSourceFingerprint>,
    private readonly onChanged: () => void = () => undefined,
  ) {}

  setProject(directory: string, project: Project): void {
    this.#directory = directory;
    this.#project = structuredClone(project);
  }

  async updateProject(project: Project): Promise<void> {
    const retained = new Set(project.assets.map(({ id }) => id));
    const removed = (this.#project?.assets ?? []).filter(({ id }) => !retained.has(id));
    this.#project = structuredClone(project);
    for (const asset of removed) await rm(await this.#path(asset.id), { force: true });
    if (removed.length > 0) this.onChanged();
  }

  clearProject(): void {
    this.#directory = null;
    this.#project = null;
  }

  async status(assetIds?: readonly string[]): Promise<VisualIndexAssetStatus[]> {
    const ids = this.#assetIds(assetIds);
    return Promise.all(ids.map((assetId) => this.#status(assetId)));
  }

  async get(
    assetId: string,
    range: { fromUs?: number; toUs?: number; limit?: number } = {},
  ): Promise<{
    status: VisualIndexAssetStatus;
    observations: VisualIndexObservation[];
    truncated: boolean;
  }> {
    const id = this.#requireAsset(assetId);
    const status = await this.#status(id);
    const artifact = await this.#read(id);
    const fromUs = range.fromUs ?? 0;
    const toUs = range.toUs ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.min(2_000, Math.max(1, range.limit ?? 500));
    if (toUs <= fromUs) throw new Error("toUs must be greater than fromUs");
    const matching = (artifact?.observations ?? []).filter(
      (observation) => observation.sourceOutUs > fromUs && observation.sourceInUs < toUs,
    );
    return { status, observations: matching.slice(0, limit), truncated: matching.length > limit };
  }

  async generate(assetIds: readonly string[], force = false): Promise<VisualIndexAssetStatus[]> {
    for (const assetId of this.#assetIds(assetIds)) {
      const current = await this.#status(assetId);
      if (!force && current.state === "current") continue;
      await this.#write(await this.#emptyArtifact(assetId));
    }
    return this.status(assetIds);
  }

  async upsert(assetId: string, values: readonly unknown[]): Promise<VisualIndexAssetStatus> {
    const id = this.#requireAsset(assetId);
    if (values.length === 0 || values.length > 500)
      throw new Error("Upsert requires 1 to 500 observations");
    const additions = values.map(parseVisualIndexObservation);
    const current = await this.#currentArtifact(id);
    const byId = new Map(current.observations.map((observation) => [observation.id, observation]));
    for (const observation of additions) byId.set(observation.id, observation);
    const observations = [...byId.values()];
    if (observations.length > MAX_OBSERVATIONS)
      throw new Error("Visual index has too many observations");
    await this.#write(normalizeVisualIndex({ ...current, coverage: observations, observations }));
    return this.#status(id);
  }

  async delete(
    assetId: string,
    selector: { observationIds?: readonly string[]; fromUs?: number; toUs?: number },
  ): Promise<VisualIndexAssetStatus> {
    const id = this.#requireAsset(assetId);
    const current = await this.#currentArtifact(id);
    const selected = new Set(selector.observationIds ?? []);
    const hasRange = selector.fromUs !== undefined || selector.toUs !== undefined;
    if (selected.size === 0 && !hasRange)
      throw new Error("Delete requires observation IDs or a source range");
    const fromUs = selector.fromUs ?? 0;
    const toUs = selector.toUs ?? Number.MAX_SAFE_INTEGER;
    if (toUs <= fromUs) throw new Error("toUs must be greater than fromUs");
    const observations = current.observations.filter(
      (observation) =>
        !selected.has(observation.id) &&
        !(hasRange && observation.sourceOutUs > fromUs && observation.sourceInUs < toUs),
    );
    await this.#write(normalizeVisualIndex({ ...current, coverage: observations, observations }));
    return this.#status(id);
  }

  async clear(assetIds: readonly string[]): Promise<VisualIndexAssetStatus[]> {
    for (const assetId of this.#assetIds(assetIds))
      await rm(await this.#path(assetId), { force: true });
    this.onChanged();
    return this.status(assetIds);
  }

  async observationRange(assetId: string, observationId: string): Promise<VisualIndexRange> {
    const result = await this.get(assetId, { limit: MAX_OBSERVATIONS });
    const observation = result.observations.find(({ id }) => id === observationId);
    if (!observation) throw new Error(`Unknown visual-index observation: ${observationId}`);
    return { sourceInUs: observation.sourceInUs, sourceOutUs: observation.sourceOutUs };
  }

  async #status(assetId: AssetId): Promise<VisualIndexAssetStatus> {
    const artifact = await this.#read(assetId);
    if (!artifact) return { assetId, state: "missing", observationCount: 0, coverage: [] };
    const fingerprint = await this.fingerprintForAsset(assetId);
    const current =
      artifact.generatorVersion === VISUAL_INDEX_GENERATOR_VERSION &&
      projectSourceFingerprintsEqual(artifact.sourceFingerprint, fingerprint);
    return {
      assetId,
      state: current ? "current" : "stale",
      observationCount: artifact.observations.length,
      coverage: artifact.coverage,
      generatorVersion: artifact.generatorVersion,
    };
  }

  async #currentArtifact(assetId: AssetId): Promise<VisualIndexArtifact> {
    const artifact = await this.#read(assetId);
    const fingerprint = await this.fingerprintForAsset(assetId);
    if (
      artifact &&
      artifact.generatorVersion === VISUAL_INDEX_GENERATOR_VERSION &&
      projectSourceFingerprintsEqual(artifact.sourceFingerprint, fingerprint)
    )
      return artifact;
    return this.#emptyArtifact(assetId, fingerprint);
  }

  async #emptyArtifact(
    assetId: AssetId,
    sourceFingerprint?: ProjectSourceFingerprint,
  ): Promise<VisualIndexArtifact> {
    return {
      version: VISUAL_INDEX_VERSION,
      assetId,
      sourceFingerprint: sourceFingerprint ?? (await this.fingerprintForAsset(assetId)),
      generatorVersion: VISUAL_INDEX_GENERATOR_VERSION,
      options: {},
      coverage: [],
      observations: [],
    };
  }

  #assetIds(assetIds?: readonly string[]): AssetId[] {
    const ids = assetIds ?? this.#requireProject().assets.map(({ id }) => id);
    if (ids.length > 100) throw new Error("Visual-index requests are limited to 100 assets");
    return [...new Set(ids.map((assetId) => this.#requireAsset(assetId)))];
  }

  #requireAsset(assetId: string): AssetId {
    const asset = this.#requireProject().assets.find(({ id }) => id === assetId);
    if (!asset) throw new Error(`Unknown asset: ${assetId}`);
    return asset.id;
  }

  #requireProject(): Project {
    if (!this.#project) throw new Error("No visual-index project is open");
    return this.#project;
  }

  async #path(assetId: AssetId): Promise<string> {
    const paths = await ProjectPaths.open(this.#directory ?? "");
    return paths.derived(`.video/visual-index/${assetId}.json`);
  }

  async #read(assetId: AssetId): Promise<VisualIndexArtifact | null> {
    const path = await this.#path(assetId);
    const metadata = await stat(path).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!metadata) return null;
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARTIFACT_BYTES)
      throw new Error("Visual-index artifact is unavailable or too large");
    const artifact = parseVisualIndexArtifact(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (artifact.assetId !== assetId) throw new Error("Visual-index artifact asset mismatch");
    return artifact;
  }

  async #write(value: VisualIndexArtifact): Promise<void> {
    const artifact = normalizeVisualIndex(value);
    const paths = await ProjectPaths.open(this.#directory ?? "");
    await paths.ensureLayout(["visual-index"]);
    const path = await this.#path(artifact.assetId);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    this.onChanged();
  }
}

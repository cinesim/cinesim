import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { sequenceDurationUs, timeUs } from "@cinesim/core";
import type { Project, Sequence, TimeUs } from "@cinesim/core";
import type {
  DerivedProjectScope,
  ExportCapabilitySnapshot,
  ExportJobSnapshot,
  ExportPreset,
  ExportPresetId,
  ExportRenderCompletion,
  ExportRenderRequest,
  ExportStartRequest,
} from "../../shared/contracts";

export const MAX_EXPORT_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_JOBS_RETAINED = 20;
const MAX_EXPORT_COVERAGE_SEGMENTS = 1_024;

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: "h264-aac-sdr-1080p",
    label: "H.264/AAC SDR 1080p",
    container: "mp4",
    videoCodec: "avc",
    audioCodec: "aac",
    colorSpace: "rec709-sdr",
    maximumLongEdge: 1920,
    sampleRate: 48_000,
    audioChannels: 2,
  },
  {
    id: "h264-aac-sdr-source",
    label: "H.264/AAC SDR source size",
    container: "mp4",
    videoCodec: "avc",
    audioCodec: "aac",
    colorSpace: "rec709-sdr",
    maximumLongEdge: null,
    sampleRate: 48_000,
    audioChannels: 2,
  },
];

interface OpenExportProject {
  directory: string;
  project: Project;
  acceptedGeneration: string;
  scope: DerivedProjectScope;
}

interface ActiveExport {
  snapshot: ExportJobSnapshot;
  temporaryPath: string;
  finalPath: string;
  writer: FileHandle;
  maxEnd: number;
  coverage: Array<readonly [number, number]>;
}

function addCoverage(coverage: Array<readonly [number, number]>, start: number, end: number): void {
  let index = coverage.findIndex((segment) => segment[1] >= start);
  if (index < 0) index = coverage.length;
  let from = start;
  let to = end;
  while (index < coverage.length && coverage[index]![0] <= to) {
    from = Math.min(from, coverage[index]![0]);
    to = Math.max(to, coverage[index]![1]);
    coverage.splice(index, 1);
  }
  coverage.splice(index, 0, [from, to]);
  if (coverage.length > MAX_EXPORT_COVERAGE_SEGMENTS)
    throw new Error("Export chunk coverage is too fragmented");
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function exportSize(sequence: Sequence, preset: ExportPreset): { width: number; height: number } {
  const limit = preset.maximumLongEdge;
  const scale = limit === null ? 1 : Math.min(1, limit / Math.max(sequence.width, sequence.height));
  return { width: even(sequence.width * scale), height: even(sequence.height * scale) };
}

function presetById(id: ExportPresetId): ExportPreset {
  const preset = EXPORT_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown export preset: ${id}`);
  return preset;
}

function requestedFileName(input: string | undefined, sequenceId: string): string {
  if (input === undefined) return `${sequenceId}.mp4`;
  const name = basename(input.trim());
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.mp4$/u.test(name))
    throw new Error("Export file name must be a bounded MP4 base name");
  return name;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function exportRange(
  sequence: Sequence,
  request: ExportStartRequest,
): { startUs: TimeUs; endUs: TimeUs } {
  const durationUs = sequenceDurationUs(sequence);
  const startUs = timeUs(Math.round(request.startUs ?? 0));
  const endUs = timeUs(Math.round(request.endUs ?? durationUs));
  if (startUs < 0 || endUs <= startUs || endUs > durationUs)
    throw new Error("Export range must be positive and contained by the accepted timeline");
  return { startUs, endUs };
}

/** Owns explicit export requests and atomic filesystem publication; rendering remains renderer-local. */
export class ExportService {
  #open: OpenExportProject | null = null;
  #active: ActiveExport | null = null;
  readonly #jobs: ExportJobSnapshot[] = [];
  readonly #listeners = new Set<(jobs: ExportJobSnapshot[]) => void>();

  constructor(
    private readonly dispatch: (request: ExportRenderRequest) => boolean,
    private readonly cancelDispatch: (jobId: string) => void = () => undefined,
  ) {}

  capabilities(): ExportCapabilitySnapshot {
    return {
      presets: EXPORT_PRESETS.map((preset) => ({ ...preset })),
      rendererRequired: true,
      maximumConcurrentJobs: 1,
    };
  }

  subscribe(listener: (jobs: ExportJobSnapshot[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async setProject(input: OpenExportProject): Promise<void> {
    await this.#cancelActive("project-changed", "The open project changed", true);
    this.#open = structuredClone(input);
    this.#jobs.length = 0;
    this.#notify();
  }

  async clearProject(): Promise<void> {
    await this.#cancelActive("project-closed", "The project was closed", true);
    this.#open = null;
    this.#jobs.length = 0;
    this.#notify();
  }

  status(jobId?: string): ExportJobSnapshot[] {
    return this.#jobs
      .filter((job) => jobId === undefined || job.id === jobId)
      .map((job) => structuredClone(job));
  }

  async start(request: ExportStartRequest): Promise<ExportJobSnapshot> {
    if (this.#active) throw new Error("Only one export may render at a time");
    const openProject = this.#requireOpen();
    const sequenceId = request.sequenceId ?? openProject.project.activeSequenceId;
    const sequence = openProject.project.sequences.find((candidate) => candidate.id === sequenceId);
    if (!sequence) throw new Error(`Unknown export timeline: ${sequenceId}`);
    const preset = presetById(request.presetId);
    const range = exportRange(sequence, request);
    const size = exportSize(sequence, preset);
    const exportDirectory = join(openProject.directory, ".video", "exports");
    const finalPath = join(exportDirectory, requestedFileName(request.fileName, sequence.id));
    if (await pathExists(finalPath)) throw new Error(`Export already exists: ${finalPath}`);
    await mkdir(exportDirectory, { recursive: true });
    const id = `export_${randomUUID().replaceAll("-", "")}`;
    const temporaryPath = join(exportDirectory, `.${id}.partial.mp4`);
    const writer = await open(temporaryPath, "wx", 0o600);
    const snapshot: ExportJobSnapshot = {
      id,
      state: "queued",
      sequenceId: sequence.id,
      presetId: preset.id,
      ...range,
      ...size,
      frameRate: sequence.frameRate,
      progress: 0,
      acceptedGeneration: openProject.acceptedGeneration,
      outputPath: finalPath,
    };
    this.#active = { snapshot, temporaryPath, finalPath, writer, maxEnd: 0, coverage: [] };
    this.#remember(snapshot);
    if (!this.dispatch({ job: structuredClone(snapshot), projectScope: openProject.scope })) {
      await this.#failActive("renderer-unavailable", "An open renderer is required for export");
      throw new Error("An open renderer is required for export");
    }
    snapshot.state = "rendering";
    this.#notify();
    return structuredClone(snapshot);
  }

  async writeChunk(jobId: string, offset: number, data: Uint8Array): Promise<void> {
    const active = this.#requireActive(jobId);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid export chunk offset");
    if (data.byteLength === 0 || data.byteLength > MAX_EXPORT_CHUNK_BYTES)
      throw new Error("Invalid export chunk size");
    await active.writer.write(data, 0, data.byteLength, offset);
    active.maxEnd = Math.max(active.maxEnd, offset + data.byteLength);
    addCoverage(active.coverage, offset, offset + data.byteLength);
  }

  updateProgress(jobId: string, progress: number): void {
    const active = this.#requireActive(jobId);
    if (!Number.isFinite(progress)) throw new Error("Invalid export progress");
    active.snapshot.progress = Math.max(
      active.snapshot.progress,
      Math.min(1, Math.max(0, progress)),
    );
    this.#notify();
  }

  async complete(completion: ExportRenderCompletion): Promise<ExportJobSnapshot> {
    const active = this.#requireActive(completion.jobId);
    if (
      completion.bytes <= 0 ||
      completion.bytes !== active.maxEnd ||
      active.coverage.length !== 1 ||
      active.coverage[0]?.[0] !== 0 ||
      active.coverage[0][1] !== completion.bytes
    )
      throw new Error("Export byte count does not match the streamed artifact");
    await active.writer.sync();
    await active.writer.close();
    await link(active.temporaryPath, active.finalPath);
    await rm(active.temporaryPath);
    const published = await stat(active.finalPath);
    active.snapshot.state = "completed";
    active.snapshot.progress = 1;
    active.snapshot.bytes = published.size;
    this.#active = null;
    this.#notify();
    return structuredClone(active.snapshot);
  }

  async fail(jobId: string, code: string, detail: string): Promise<void> {
    this.#requireActive(jobId);
    await this.#failActive(code, detail);
  }

  async cancel(jobId: string): Promise<ExportJobSnapshot> {
    const active = this.#requireActive(jobId);
    this.cancelDispatch(jobId);
    await this.#cancelActive("canceled", "Export canceled", false);
    return structuredClone(active.snapshot);
  }

  #requireOpen(): OpenExportProject {
    if (!this.#open) throw new Error("No project is open");
    return this.#open;
  }

  #requireActive(jobId: string): ActiveExport {
    if (!this.#active || this.#active.snapshot.id !== jobId)
      throw new Error("Unknown or inactive export job");
    return this.#active;
  }

  #remember(snapshot: ExportJobSnapshot): void {
    this.#jobs.unshift(snapshot);
    this.#jobs.splice(MAX_EXPORT_JOBS_RETAINED);
    this.#notify();
  }

  async #failActive(code: string, detail: string): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.snapshot.state = "failed";
    active.snapshot.failureCode = code;
    active.snapshot.detail = detail.slice(0, 2_000);
    this.#active = null;
    await active.writer.close().catch(() => undefined);
    await rm(active.temporaryPath, { force: true }).catch(() => undefined);
    this.#notify();
  }

  async #cancelActive(code: string, detail: string, dispatch: boolean): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (dispatch) this.cancelDispatch(active.snapshot.id);
    active.snapshot.state = "canceled";
    active.snapshot.failureCode = code;
    active.snapshot.detail = detail;
    this.#active = null;
    await active.writer.close().catch(() => undefined);
    await rm(active.temporaryPath, { force: true }).catch(() => undefined);
    this.#notify();
  }

  #notify(): void {
    const snapshot = this.status();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

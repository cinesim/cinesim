import { DEFAULT_TRANSFORM, clipEndUs, getSequence, sequenceDurationUs } from "@cinesim/core";
import type { AssetId, Project, TimeUs } from "@cinesim/core";
import type { PreviewCompositor } from "../compositor/webgpu-compositor";
import { MediabunnyWebCodecsSource } from "../media/mediabunny-source";
import type {
  AudioSource,
  MediaSourceDescriptor,
  MediaSourceKind,
  MediaSourceResolver,
  VideoSource,
  VideoSourceFactory,
} from "../media/video-source";
import { WebAudioScheduler } from "../playback/audio-scheduler";
import { MonotonicPlaybackClock } from "../playback/clock";
import { findUpcomingLayers, resolveScene } from "../playback/scene-resolver";
import { LatestOnlyExecutor } from "./latest-only-executor";

export type PreviewMode =
  | { kind: "timeline"; timeUs: TimeUs }
  | { kind: "asset"; assetId: AssetId; sourceTimeUs: TimeUs };

export type ForegroundPressure = "idle" | "hover-skimming" | "seeking" | "playing";

export interface RuntimeSnapshot {
  mode: PreviewMode;
  timeUs: TimeUs;
  playing: boolean;
  activeAssetId: AssetId | null;
  activeSourceKind: MediaSourceKind | null;
  foregroundPressure: ForegroundPressure;
  renderFps: number;
  targetFps: number;
  droppedFrames: number;
  frameOperationsInFlight: number;
  newestRequestPending: boolean;
  requestsReceived: number;
  requestsCoalesced: number;
  framesPresented: number;
  framesObsolete: number;
  failedRequests: number;
  activeSources: number;
  activeClips: number;
  seekLatencyMs: number;
  gpuSubmitCpuMs: number;
  gpuSubmittedFrames: number;
  gpuDeviceLostCount: number;
  previewWidth: number;
  previewHeight: number;
  sourcePreviewSuppressions: number;
}

export interface PlaybackRuntimeOptions {
  sourceFactory?: VideoSourceFactory;
  sourceResolver?: MediaSourceResolver;
  now?: () => number;
}

interface RenderRequest {
  mode: PreviewMode;
  reason: "initial" | "project" | "timeline-seek" | "playback" | "asset-preview" | "restore";
}

const defaultResolver: MediaSourceResolver = {
  resolve: (assetId) => ({
    assetId,
    kind: "original",
    url: `cinesim-media://asset/${assetId}`,
  }),
};

const defaultSourceFactory: VideoSourceFactory = (descriptor) =>
  new MediabunnyWebCodecsSource(descriptor.url);

export class PlaybackRuntime {
  #project: Project;
  readonly #compositor: PreviewCompositor;
  readonly #clock: MonotonicPlaybackClock;
  readonly #now: () => number;
  readonly #sourceFactory: VideoSourceFactory;
  readonly #sourceResolver: MediaSourceResolver;
  readonly #sources = new Map<string, VideoSource & Partial<AudioSource>>();
  readonly #sourceDescriptors = new Map<AssetId, MediaSourceDescriptor>();
  readonly #listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  readonly #executor: LatestOnlyExecutor<RenderRequest, void>;
  #mode: PreviewMode = { kind: "timeline", timeUs: 0 };
  #initialized = false;
  #destroyed = false;
  #animationFrame = 0;
  #lastSnapshotAt = 0;
  #renderedSinceSnapshot = 0;
  #droppedFrames = 0;
  #seekLatencyMs = 0;
  #lastActiveAssetId: AssetId | null = null;
  #lastActiveSourceKind: MediaSourceKind | null = null;
  #sourcePreviewSuppressions = 0;
  #audioScheduler: WebAudioScheduler | null = null;
  #audioScheduledUntilUs: TimeUs = 0;
  #audioScheduling = false;

  constructor(
    project: Project,
    compositor: PreviewCompositor,
    options: PlaybackRuntimeOptions = {},
  ) {
    this.#project = project;
    this.#compositor = compositor;
    this.#now = options.now ?? (() => performance.now());
    this.#clock = new MonotonicPlaybackClock(this.#now);
    this.#sourceFactory = options.sourceFactory ?? defaultSourceFactory;
    this.#sourceResolver = options.sourceResolver ?? defaultResolver;
    this.#executor = new LatestOnlyExecutor(async (request, context) => {
      const started = this.#now();
      const frames = await this.#decode(request.mode);
      if (!context.isCurrent() || this.#destroyed) {
        for (const layer of frames) layer.frame.close();
        return;
      }
      const sequence = getSequence(this.#project);
      this.#compositor.render(frames, { width: sequence.width, height: sequence.height });
      this.#renderedSinceSnapshot += 1;
      this.#mode = request.mode;
      if (request.mode.kind === "timeline") this.#clock.seek(request.mode.timeUs);
      if (request.reason === "timeline-seek" || request.reason === "asset-preview")
        this.#seekLatencyMs = this.#now() - started;
      this.#prewarm(request.mode);
      if (this.#now() - this.#lastSnapshotAt >= 100) this.#emit();
    });
  }

  async initialize(): Promise<void> {
    if (this.#initialized || this.#destroyed) return;
    await this.#compositor.initialize();
    if (this.#destroyed) return;
    this.#initialized = true;
    await this.#request({ kind: "timeline", timeUs: this.#clock.now() }, "initial");
    this.#emit();
  }

  setProject(project: Project): void {
    this.#project = project;
    if (this.#initialized)
      void this.#request({ kind: "timeline", timeUs: this.#clock.now() }, "project").catch(
        () => undefined,
      );
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot());
    return () => this.#listeners.delete(listener);
  }

  play(): void {
    if (this.#clock.playing || this.#destroyed) return;
    if (this.#mode.kind === "asset") void this.exitAssetPreview();
    this.#clock.play();
    void this.#startAudio(this.#clock.now());
    this.#tick();
  }

  playTimeline(): void {
    this.play();
  }

  pause(): void {
    this.#clock.pause();
    this.#audioScheduler?.stop();
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.#animationFrame);
    this.#emit();
  }

  pauseTimeline(): void {
    this.pause();
  }

  async seek(timeUs: TimeUs): Promise<void> {
    await this.seekTimeline(timeUs);
  }

  async seekTimeline(timeUs: TimeUs): Promise<void> {
    const durationUs = sequenceDurationUs(getSequence(this.#project));
    const safeTimeUs = Math.max(0, Math.min(Math.round(timeUs), durationUs));
    this.#mode = { kind: "timeline", timeUs: safeTimeUs };
    await this.#request(this.#mode, "timeline-seek");
    if (this.#clock.playing) void this.#startAudio(safeTimeUs);
    this.#emit();
  }

  enterAssetPreview(assetId: AssetId, sourceTimeUs: TimeUs): void {
    if (this.#clock.playing) {
      this.#sourcePreviewSuppressions += 1;
      this.#emit();
      return;
    }
    const mode: PreviewMode = { kind: "asset", assetId, sourceTimeUs };
    this.#mode = mode;
    void this.#request(mode, "asset-preview").catch(() => undefined);
  }

  updateAssetPreview(sourceTimeUs: TimeUs): void {
    if (this.#mode.kind !== "asset") return;
    this.enterAssetPreview(this.#mode.assetId, sourceTimeUs);
  }

  async exitAssetPreview(): Promise<void> {
    if (this.#mode.kind !== "asset") return;
    const mode: PreviewMode = { kind: "timeline", timeUs: this.#clock.now() };
    this.#mode = mode;
    await this.#request(mode, "restore");
    this.#emit();
  }

  invalidateSource(assetId?: AssetId): void {
    this.#sourceResolver.invalidate?.(assetId);
    for (const [key, source] of this.#sources) {
      if (!assetId || key.startsWith(`${assetId}:`)) {
        source.destroy();
        this.#sources.delete(key);
      }
    }
    if (assetId) this.#sourceDescriptors.delete(assetId);
    else this.#sourceDescriptors.clear();
  }

  #tick = (): void => {
    if (!this.#clock.playing || this.#destroyed) return;
    const duration = sequenceDurationUs(getSequence(this.#project));
    const timeUs = Math.min(this.#clock.now(), duration);
    if (timeUs >= duration) {
      this.pause();
      return;
    }
    const metrics = this.#executor.metrics;
    if (metrics.inFlight) this.#droppedFrames += 1;
    void this.#request({ kind: "timeline", timeUs }, "playback").catch(() => undefined);
    if (this.#audioScheduledUntilUs - timeUs < 700_000 && !this.#audioScheduling)
      void this.#scheduleAudioWindow(this.#audioScheduledUntilUs, timeUs + 1_800_000);
    if (this.#now() - this.#lastSnapshotAt > 100) this.#emit();
    this.#animationFrame = requestAnimationFrame(this.#tick);
  };

  async #request(mode: PreviewMode, reason: RenderRequest["reason"]): Promise<void> {
    if (!this.#initialized || this.#destroyed) return;
    await this.#executor.run({ mode, reason });
  }

  async #decode(mode: PreviewMode) {
    if (mode.kind === "asset") {
      const asset = this.#project.assets.find((candidate) => candidate.id === mode.assetId);
      if (!asset || asset.kind !== "video") return [];
      const descriptor = this.#sourceResolver.resolve(asset.id);
      this.#lastActiveAssetId = asset.id;
      this.#lastActiveSourceKind = descriptor.kind;
      const frame = await this.#source(descriptor).getFrame(mode.sourceTimeUs);
      return frame ? [{ frame, transform: DEFAULT_TRANSFORM }] : [];
    }
    const layers = resolveScene(this.#project, mode.timeUs);
    const frames = await Promise.all(
      layers.map(async (layer) => {
        const descriptor = this.#sourceResolver.resolve(layer.asset.id);
        const frame = await this.#source(descriptor).getFrame(layer.sourceTimeUs);
        return frame ? { frame, transform: layer.clip.transform } : null;
      }),
    );
    const active = layers.at(-1);
    this.#lastActiveAssetId = active?.asset.id ?? null;
    this.#lastActiveSourceKind = active ? this.#sourceResolver.resolve(active.asset.id).kind : null;
    return frames.filter((value): value is NonNullable<typeof value> => value !== null);
  }

  #source(descriptor: MediaSourceDescriptor): VideoSource & Partial<AudioSource> {
    const key = `${descriptor.assetId}:${descriptor.kind}:${descriptor.url}`;
    let source = this.#sources.get(key);
    if (!source) {
      source = this.#sourceFactory(descriptor);
      this.#sources.set(key, source);
      this.#sourceDescriptors.set(descriptor.assetId, descriptor);
    }
    return source;
  }

  #prewarm(mode: PreviewMode): void {
    if (mode.kind !== "timeline") return;
    for (const upcoming of findUpcomingLayers(this.#project, mode.timeUs)) {
      const descriptor = this.#sourceResolver.resolve(upcoming.asset.id);
      void this.#source(descriptor).prepare();
    }
  }

  async #startAudio(timeUs: TimeUs): Promise<void> {
    this.#audioScheduler ??= new WebAudioScheduler();
    await this.#audioScheduler.resume();
    this.#audioScheduler.startTransport(timeUs);
    this.#audioScheduledUntilUs = timeUs;
    await this.#scheduleAudioWindow(timeUs, timeUs + 1_800_000);
  }

  async #scheduleAudioWindow(fromUs: TimeUs, toUs: TimeUs): Promise<void> {
    if (!this.#audioScheduler || toUs <= fromUs) return;
    this.#audioScheduling = true;
    this.#audioScheduledUntilUs = toUs;
    try {
      const sequence = getSequence(this.#project);
      const assets = new Map(this.#project.assets.map((asset) => [asset.id, asset]));
      const work: Promise<void>[] = [];
      for (const track of sequence.tracks) {
        if (track.muted) continue;
        for (const clip of track.clips) {
          const asset = assets.get(clip.assetId);
          if (!asset?.hasAudio || clipEndUs(clip) <= fromUs || clip.timelineStartUs >= toUs)
            continue;
          const timelineFromUs = Math.max(fromUs, clip.timelineStartUs);
          const timelineToUs = Math.min(toUs, clipEndUs(clip));
          const sourceFromUs = clip.sourceStartUs + timelineFromUs - clip.timelineStartUs;
          const source = this.#source({
            assetId: asset.id,
            kind: "original",
            url: `cinesim-media://asset/${asset.id}`,
          });
          if (!source.buffers) continue;
          work.push(
            this.#audioScheduler.schedule(
              source as VideoSource & AudioSource,
              sourceFromUs,
              timelineFromUs,
              timelineToUs - timelineFromUs,
            ),
          );
        }
      }
      await Promise.all(work);
    } finally {
      this.#audioScheduling = false;
    }
  }

  #snapshot(): RuntimeSnapshot {
    const now = this.#now();
    const elapsedSeconds = Math.max((now - this.#lastSnapshotAt) / 1_000, 0.001);
    const sequence = getSequence(this.#project);
    const executor = this.#executor.metrics;
    const compositor = this.#compositor.metrics;
    const timelineTimeUs = this.#clock.now();
    const snapshot: RuntimeSnapshot = {
      mode: this.#mode,
      timeUs: timelineTimeUs,
      playing: this.#clock.playing,
      activeAssetId: this.#lastActiveAssetId,
      activeSourceKind: this.#lastActiveSourceKind,
      foregroundPressure: this.#clock.playing
        ? "playing"
        : this.#mode.kind === "asset"
          ? "hover-skimming"
          : executor.inFlight
            ? "seeking"
            : "idle",
      renderFps: Math.round(this.#renderedSinceSnapshot / elapsedSeconds),
      targetFps: sequence.frameRate,
      droppedFrames: this.#droppedFrames,
      frameOperationsInFlight: executor.inFlight,
      newestRequestPending: executor.pending > 0,
      requestsReceived: executor.received,
      requestsCoalesced: executor.coalesced,
      framesPresented: executor.completed,
      framesObsolete: executor.obsolete,
      failedRequests: executor.failed,
      activeSources: this.#sources.size,
      activeClips: resolveScene(this.#project, timelineTimeUs).length,
      seekLatencyMs: this.#seekLatencyMs,
      gpuSubmitCpuMs: compositor.gpuSubmitCpuMs,
      gpuSubmittedFrames: compositor.submittedFrames,
      gpuDeviceLostCount: compositor.deviceLostCount,
      previewWidth: sequence.width,
      previewHeight: sequence.height,
      sourcePreviewSuppressions: this.#sourcePreviewSuppressions,
    };
    this.#lastSnapshotAt = now;
    this.#renderedSinceSnapshot = 0;
    return snapshot;
  }

  #emit(): void {
    const snapshot = this.#snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.pause();
    this.#executor.destroy();
    for (const source of this.#sources.values()) source.destroy();
    this.#sources.clear();
    this.#listeners.clear();
    if (this.#audioScheduler) void this.#audioScheduler.destroy();
    this.#audioScheduler = null;
  }
}

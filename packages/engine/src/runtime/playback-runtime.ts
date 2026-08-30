import {
  DEFAULT_TRANSFORM,
  clipCarriesAudio,
  clipEndUs,
  clipFadeGainAt,
  getSequence,
  sequenceDurationUs,
  timeUs,
} from "@cinesim/core";
import type { AssetId, Project, TimeUs } from "@cinesim/core";
import type { CompositorLayer, PreviewCompositor } from "../compositor/webgpu-compositor";
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
import type { PlaybackAudioScheduler } from "../playback/audio-scheduler";
import {
  MAX_PLAYBACK_RATE,
  MonotonicPlaybackClock,
  normalizePlaybackRate,
} from "../playback/clock";
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
  playbackRate: number;
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
  masterPeakDb: readonly [number, number];
}

export interface PlaybackRuntimeOptions {
  sourceFactory?: VideoSourceFactory;
  sourceResolver?: MediaSourceResolver;
  now?: () => number;
  onError?: (error: Error) => void;
  scheduleFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  audioSchedulerFactory?: () => PlaybackAudioScheduler;
}

interface RenderRequest {
  mode: PreviewMode;
  reason:
    | "initial"
    | "project"
    | "timeline-seek"
    | "asset-preview"
    | "restore"
    | "refresh"
    | "frame-step";
}

export type ShuttleDirection = -1 | 0 | 1;

const defaultScheduleFrame = (callback: () => void): number => {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
};

const defaultCancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
};

const frameIndexAt = (timeUs: TimeUs, frameRate: number): number =>
  Math.max(0, Math.floor((timeUs * frameRate) / 1_000_000 + 0.000_1));

const frameTimeUs = (frameIndex: number, frameRate: number): TimeUs =>
  timeUs(Math.max(0, Math.round((frameIndex * 1_000_000) / frameRate)));

const frameTimestampUs = (frame: VideoFrame, fallback: TimeUs): TimeUs =>
  typeof frame.timestamp === "number" ? timeUs(Math.max(0, Math.round(frame.timestamp))) : fallback;

async function collectDecodedLayers(
  operations: readonly Promise<CompositorLayer | null>[],
): Promise<CompositorLayer[]> {
  const settled = await Promise.allSettled(operations);
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    for (const result of settled) if (result.status === "fulfilled") result.value?.frame.close();
    throw failure.reason;
  }
  const layers: CompositorLayer[] = [];
  for (const result of settled)
    if (result.status === "fulfilled" && result.value) layers.push(result.value);
  return layers;
}

/** Owns at most two decoded source frames plus the clone handed to the compositor. */
class SequentialVideoCursor {
  readonly #source: VideoSource;
  #iterator: AsyncGenerator<VideoFrame> | null = null;
  #current: VideoFrame | null = null;
  #next: VideoFrame | null = null;
  #lastRequestedUs: TimeUs | null = null;
  #generation = 0;

  constructor(source: VideoSource) {
    this.#source = source;
  }

  async frameAt(timeUs: TimeUs): Promise<VideoFrame | null> {
    if (!this.#source.frames) return this.#source.getFrame(timeUs);
    if (
      !this.#current ||
      this.#lastRequestedUs === null ||
      timeUs < this.#lastRequestedUs ||
      timeUs - this.#lastRequestedUs > 500_000
    )
      await this.#restart(timeUs);
    this.#lastRequestedUs = timeUs;
    if (!this.#current) return null;

    const currentStartUs = frameTimestampUs(this.#current, timeUs);
    const currentDurationUs = Math.max(1, Math.round(this.#current.duration ?? 1));
    if (timeUs < currentStartUs + currentDurationUs) return this.#current.clone();

    while (true) {
      if (!this.#next) {
        const generation = this.#generation;
        const result = await this.#iterator?.next();
        if (!result || result.done) break;
        if (generation !== this.#generation) {
          result.value.close();
          return null;
        }
        this.#next = result.value;
      }
      if (frameTimestampUs(this.#next, timeUs) > timeUs) break;
      this.#current.close();
      this.#current = this.#next;
      this.#next = null;
    }
    return this.#current.clone();
  }

  async #restart(requestedTimeUs: TimeUs): Promise<void> {
    await this.close();
    const generation = this.#generation;
    const frame = await this.#source.getFrame(requestedTimeUs);
    if (generation !== this.#generation) {
      frame?.close();
      return;
    }
    this.#current = frame;
    if (!this.#current || !this.#source.frames) return;
    const timestampUs = frameTimestampUs(this.#current, requestedTimeUs);
    const durationUs = Math.max(1, Math.round(this.#current.duration ?? 1));
    this.#iterator = this.#source.frames(timeUs(timestampUs + durationUs));
  }

  async close(): Promise<void> {
    this.#generation += 1;
    const iterator = this.#iterator;
    this.#iterator = null;
    this.#current?.close();
    this.#current = null;
    this.#next?.close();
    this.#next = null;
    this.#lastRequestedUs = null;
    await iterator?.return(undefined);
  }
}

const defaultResolver: MediaSourceResolver = {
  resolve: (assetId) => ({
    assetId,
    kind: "original",
    url: `cinesim-media://asset/${assetId}`,
  }),
  resolveOriginal: (assetId) => ({
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
  readonly #onError: (error: Error) => void;
  readonly #scheduleFrame: (callback: () => void) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #audioSchedulerFactory: () => PlaybackAudioScheduler;
  readonly #sources = new Map<string, VideoSource & Partial<AudioSource>>();
  readonly #sequentialCursors = new Map<string, SequentialVideoCursor>();
  readonly #sourceDescriptors = new Map<AssetId, MediaSourceDescriptor>();
  readonly #listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  readonly #executor: LatestOnlyExecutor<RenderRequest, void>;
  #mode: PreviewMode = { kind: "timeline", timeUs: timeUs(0) };
  #initialized = false;
  #destroyed = false;
  #animationFrame = 0;
  #transportGeneration = 0;
  #seekGeneration = 0;
  #resumeAfterSeek = false;
  #lastPlaybackFrameIndex: number | null = null;
  #playbackRequests = 0;
  #playbackFramesPresented = 0;
  #playbackFramesObsolete = 0;
  #playbackFailedRequests = 0;
  #playbackFrameInFlight = false;
  #lastSnapshotAt = 0;
  #renderedSinceSnapshot = 0;
  #droppedFrames = 0;
  #seekLatencyMs = 0;
  #lastActiveAssetId: AssetId | null = null;
  #lastActiveSourceKind: MediaSourceKind | null = null;
  #sourcePreviewSuppressions = 0;
  #audioScheduler: PlaybackAudioScheduler | null = null;
  #audioScheduledUntilUs: TimeUs = timeUs(0);
  #audioGeneration = 0;
  #audioStartingGeneration: number | null = null;
  #audioTransportGeneration: number | null = null;
  #audioSchedulingGeneration: number | null = null;

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
    this.#onError = options.onError ?? (() => undefined);
    this.#scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
    this.#cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    this.#audioSchedulerFactory = options.audioSchedulerFactory ?? (() => new WebAudioScheduler());
    this.#executor = new LatestOnlyExecutor(async (request, context) => {
      const started = this.#now();
      const frames = await this.#decodeRandom(request.mode);
      if (!context.isCurrent() || this.#destroyed) {
        for (const layer of frames) layer.frame.close();
        return;
      }
      const sequence = getSequence(this.#project);
      this.#compositor.render(frames, { width: sequence.width, height: sequence.height });
      this.#renderedSinceSnapshot += 1;
      this.#mode = request.mode;
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
    const shouldResume = this.#clock.playing || this.#resumeAfterSeek;
    this.#seekGeneration += 1;
    this.#resumeAfterSeek = false;
    const durationUs = sequenceDurationUs(getSequence(project));
    const safeTimeUs = timeUs(Math.max(0, Math.min(this.#clock.now(), durationUs)));
    this.#clock.seek(safeTimeUs);
    if (this.#mode.kind === "timeline") this.#mode = { kind: "timeline", timeUs: safeTimeUs };
    this.#resetSequentialCursors();
    if (!this.#initialized) return;
    if (shouldResume) {
      if (!this.#clock.playing) this.#clock.play();
      this.#stopAudio();
      if (this.#clock.rate === 1 && this.#hasAudibleContent())
        this.#restartAudio(this.#clock.now());
      this.#startTransportLoop();
      this.#emit();
      return;
    }
    const mode =
      this.#mode.kind === "asset"
        ? this.#mode
        : { kind: "timeline" as const, timeUs: this.#clock.now() };
    this.#emit();
    this.#runBackground(this.#request(mode, "project"));
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot());
    return () => this.#listeners.delete(listener);
  }

  play(): void {
    if (this.#clock.playing || this.#destroyed) return;
    this.#clock.setRate(1);
    this.#startPlaying();
  }

  #startPlaying(): void {
    this.#seekGeneration += 1;
    this.#resumeAfterSeek = false;
    if (this.#mode.kind === "asset") {
      const mode: PreviewMode = { kind: "timeline", timeUs: this.#clock.now() };
      this.#mode = mode;
    }
    this.#clock.play();
    if (this.#clock.rate === 1 && this.#hasAudibleContent()) this.#restartAudio(this.#clock.now());
    this.#startTransportLoop();
    this.#emit();
  }

  playTimeline(): void {
    this.play();
  }

  pause(): void {
    const pendingPlayingSeek = this.#resumeAfterSeek;
    this.#seekGeneration += 1;
    this.#resumeAfterSeek = false;
    if (!this.#clock.playing && !this.#animationFrame) {
      if (pendingPlayingSeek) {
        this.#executor.invalidate();
        this.#stopAudio();
        this.#emit();
      }
      return;
    }
    this.#clock.pause();
    this.#transportGeneration += 1;
    this.#lastPlaybackFrameIndex = null;
    this.#audioGeneration += 1;
    this.#audioStartingGeneration = null;
    this.#audioTransportGeneration = null;
    this.#audioSchedulingGeneration = null;
    this.#stopAudioScheduler();
    if (this.#animationFrame) this.#cancelFrame(this.#animationFrame);
    this.#animationFrame = 0;
    this.#resetSequentialCursors();
    this.#emit();
  }

  pauseTimeline(): void {
    this.pause();
  }

  async seek(requestedTimeUs: TimeUs): Promise<void> {
    await this.seekTimeline(requestedTimeUs);
  }

  async seekTimeline(requestedTimeUs: TimeUs): Promise<void> {
    const durationUs = sequenceDurationUs(getSequence(this.#project));
    const safeTimeUs = timeUs(Math.max(0, Math.min(Math.round(requestedTimeUs), durationUs)));
    const shouldResume = this.#clock.playing || this.#resumeAfterSeek;
    const seekGeneration = ++this.#seekGeneration;
    this.#resumeAfterSeek = shouldResume;
    if (this.#clock.playing) this.#clock.pause();
    if (shouldResume) this.#stopAudio();
    this.#transportGeneration += 1;
    if (this.#animationFrame) this.#cancelFrame(this.#animationFrame);
    this.#animationFrame = 0;
    this.#lastPlaybackFrameIndex = null;
    this.#resetSequentialCursors();
    this.#clock.seek(safeTimeUs);
    this.#mode = { kind: "timeline", timeUs: safeTimeUs };
    await this.#request(this.#mode, "timeline-seek");
    if (seekGeneration !== this.#seekGeneration || this.#destroyed) return;
    this.#resumeAfterSeek = false;
    if (shouldResume) {
      this.#clock.play();
      if (this.#clock.rate === 1 && this.#hasAudibleContent())
        this.#restartAudio(this.#clock.now());
      this.#startTransportLoop();
    }
    this.#emit();
  }

  async stepFrames(deltaFrames: number): Promise<void> {
    if (!Number.isSafeInteger(deltaFrames)) throw new Error("Frame delta must be an integer");
    if (deltaFrames === 0) return this.refresh();
    this.pause();
    const sequence = getSequence(this.#project);
    const durationUs = sequenceDurationUs(sequence);
    const frameCount = Math.max(1, Math.ceil((durationUs * sequence.frameRate) / 1_000_000));
    const currentFrame = frameIndexAt(this.#clock.now(), sequence.frameRate);
    const targetFrame = Math.max(0, Math.min(currentFrame + deltaFrames, frameCount - 1));
    const targetUs = timeUs(Math.min(durationUs, frameTimeUs(targetFrame, sequence.frameRate)));
    this.#clock.seek(targetUs);
    this.#mode = { kind: "timeline", timeUs: targetUs };
    await this.#request(this.#mode, "frame-step");
    this.#emit();
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate)) throw new Error("Playback rate must be finite");
    if (rate === 0) {
      this.pause();
      return;
    }
    const normalized = normalizePlaybackRate(rate);
    const changed = normalized !== this.#clock.rate;
    this.#clock.setRate(normalized);
    if (!this.#clock.playing) {
      this.#startPlaying();
      return;
    }
    if (!changed) return;
    this.#stopAudio();
    if (normalized === 1 && this.#hasAudibleContent()) this.#restartAudio(this.#clock.now());
    this.#startTransportLoop();
    this.#emit();
  }

  shuttle(direction: ShuttleDirection): void {
    if (direction === 0) {
      this.pause();
      return;
    }
    const sameDirection = this.#clock.playing && Math.sign(this.#clock.rate) === direction;
    const speed = sameDirection ? Math.min(Math.abs(this.#clock.rate) * 2, MAX_PLAYBACK_RATE) : 1;
    this.setPlaybackRate(direction * speed);
  }

  async refresh(): Promise<void> {
    if (!this.#initialized || this.#destroyed || this.#clock.playing) return;
    const mode: PreviewMode =
      this.#mode.kind === "asset" ? this.#mode : { kind: "timeline", timeUs: this.#clock.now() };
    await this.#request(mode, "refresh");
    this.#emit();
  }

  enterAssetPreview(assetId: AssetId, sourceTimeUs: TimeUs): void {
    if (this.#clock.playing || this.#resumeAfterSeek) {
      this.#sourcePreviewSuppressions += 1;
      this.#emit();
      return;
    }
    const mode: PreviewMode = { kind: "asset", assetId, sourceTimeUs };
    this.#mode = mode;
    // Preview mode is UI state as well as a render request. Publish it before
    // decode so an empty-timeline overlay cannot cover source footage while a
    // slow first frame is loading.
    this.#emit();
    this.#runBackground(this.#request(mode, "asset-preview"));
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
    this.#resetSequentialCursors();
    if (assetId) this.#sourceDescriptors.delete(assetId);
    else this.#sourceDescriptors.clear();
  }

  #startTransportLoop(): void {
    const generation = ++this.#transportGeneration;
    this.#executor.invalidate();
    this.#lastPlaybackFrameIndex = null;
    if (this.#animationFrame) this.#cancelFrame(this.#animationFrame);
    this.#animationFrame = 0;
    this.#resetSequentialCursors();
    this.#runBackground(this.#tick(generation));
  }

  async #tick(generation: number): Promise<void> {
    if (!this.#isCurrentTransport(generation)) return;
    const sequence = getSequence(this.#project);
    const durationUs = sequenceDurationUs(sequence);
    const rawTimeUs = this.#clock.now();
    if (
      (this.#clock.rate > 0 && rawTimeUs >= durationUs) ||
      (this.#clock.rate < 0 && rawTimeUs <= 0)
    ) {
      this.#clock.seek(this.#clock.rate > 0 ? durationUs : timeUs(0));
      this.pause();
      return;
    }

    const safeTimeUs = timeUs(Math.max(0, Math.min(rawTimeUs, durationUs)));
    const frameIndex = frameIndexAt(safeTimeUs, sequence.frameRate);
    if (frameIndex !== this.#lastPlaybackFrameIndex) {
      if (this.#lastPlaybackFrameIndex !== null)
        this.#droppedFrames += Math.max(0, Math.abs(frameIndex - this.#lastPlaybackFrameIndex) - 1);
      this.#lastPlaybackFrameIndex = frameIndex;
      this.#playbackRequests += 1;
      const mode: PreviewMode = {
        kind: "timeline",
        timeUs: frameTimeUs(frameIndex, sequence.frameRate),
      };
      this.#playbackFrameInFlight = true;
      let frames;
      try {
        frames =
          this.#clock.rate > 0
            ? await this.#decodeSequential(mode.timeUs)
            : await this.#decodeRandom(mode);
      } catch (error) {
        this.#playbackFailedRequests += 1;
        if (this.#isCurrentTransport(generation)) this.#scheduleTransportTick(generation);
        throw error;
      } finally {
        this.#playbackFrameInFlight = false;
      }
      if (!this.#isCurrentTransport(generation)) {
        for (const layer of frames) layer.frame.close();
        this.#playbackFramesObsolete += 1;
        return;
      }
      this.#compositor.render(frames, { width: sequence.width, height: sequence.height });
      this.#renderedSinceSnapshot += 1;
      this.#playbackFramesPresented += 1;
      this.#mode = mode;
      this.#prewarm(mode);
    }

    if (
      this.#clock.rate === 1 &&
      this.#audioScheduledUntilUs - safeTimeUs < 700_000 &&
      this.#audioTransportGeneration === this.#audioGeneration &&
      this.#audioStartingGeneration !== this.#audioGeneration &&
      this.#audioSchedulingGeneration !== this.#audioGeneration
    )
      this.#runBackground(
        this.#scheduleAudioWindow(
          this.#audioScheduledUntilUs,
          timeUs(safeTimeUs + 1_800_000),
          this.#audioGeneration,
        ),
      );
    if (this.#now() - this.#lastSnapshotAt > 100) this.#emit();
    if (!this.#isCurrentTransport(generation)) return;
    this.#scheduleTransportTick(generation);
  }

  #scheduleTransportTick(generation: number): void {
    this.#animationFrame = this.#scheduleFrame(() => {
      this.#animationFrame = 0;
      this.#runBackground(this.#tick(generation));
    });
  }

  #isCurrentTransport(generation: number): boolean {
    return this.#clock.playing && !this.#destroyed && generation === this.#transportGeneration;
  }

  async #request(mode: PreviewMode, reason: RenderRequest["reason"]): Promise<void> {
    if (!this.#initialized || this.#destroyed) return;
    await this.#executor.run({ mode, reason });
  }

  async #decodeRandom(mode: PreviewMode) {
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
    const frames = await collectDecodedLayers(
      layers.map(async (layer) => {
        const descriptor = this.#sourceResolver.resolve(layer.asset.id);
        const frame = await this.#source(descriptor).getFrame(layer.sourceTimeUs);
        return frame
          ? {
              frame,
              transform: {
                ...layer.clip.transform,
                opacity: layer.clip.transform.opacity * clipFadeGainAt(layer.clip, mode.timeUs),
              },
            }
          : null;
      }),
    );
    const active = layers.at(-1);
    this.#lastActiveAssetId = active?.asset.id ?? null;
    this.#lastActiveSourceKind = active ? this.#sourceResolver.resolve(active.asset.id).kind : null;
    return frames;
  }

  async #decodeSequential(timeUs: TimeUs) {
    const layers = resolveScene(this.#project, timeUs);
    const activeCursorKeys = new Set<string>();
    let frames: CompositorLayer[];
    try {
      frames = await collectDecodedLayers(
        layers.map(async (layer) => {
          const descriptor = this.#sourceResolver.resolve(layer.asset.id);
          const source = this.#source(descriptor);
          const key = `${layer.clip.id}:${descriptor.assetId}:${descriptor.kind}:${descriptor.url}`;
          activeCursorKeys.add(key);
          let cursor = this.#sequentialCursors.get(key);
          if (!cursor) {
            cursor = new SequentialVideoCursor(source);
            this.#sequentialCursors.set(key, cursor);
          }
          const frame = await cursor.frameAt(layer.sourceTimeUs);
          return frame
            ? {
                frame,
                transform: {
                  ...layer.clip.transform,
                  opacity: layer.clip.transform.opacity * clipFadeGainAt(layer.clip, timeUs),
                },
              }
            : null;
        }),
      );
    } finally {
      for (const [key, cursor] of this.#sequentialCursors) {
        if (activeCursorKeys.has(key)) continue;
        this.#sequentialCursors.delete(key);
        this.#runBackground(cursor.close());
      }
    }
    const active = layers.at(-1);
    this.#lastActiveAssetId = active?.asset.id ?? null;
    this.#lastActiveSourceKind = active ? this.#sourceResolver.resolve(active.asset.id).kind : null;
    return frames;
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
      this.#runBackground(this.#source(descriptor).prepare());
    }
  }

  #resetSequentialCursors(): void {
    const cursors = [...this.#sequentialCursors.values()];
    this.#sequentialCursors.clear();
    for (const cursor of cursors) this.#runBackground(cursor.close());
  }

  #stopAudio(): void {
    this.#audioGeneration += 1;
    this.#audioStartingGeneration = null;
    this.#audioTransportGeneration = null;
    this.#audioSchedulingGeneration = null;
    this.#stopAudioScheduler();
  }

  #hasAudibleContent(): boolean {
    const assets = new Map(this.#project.assets.map((asset) => [asset.id, asset]));
    return getSequence(this.#project).tracks.some((track) =>
      track.clips.some((clip) => {
        const asset = assets.get(clip.assetId);
        return asset ? clipCarriesAudio(asset, clip, track) : false;
      }),
    );
  }

  #restartAudio(timeUs: TimeUs): void {
    const generation = ++this.#audioGeneration;
    this.#audioStartingGeneration = generation;
    this.#audioTransportGeneration = null;
    this.#stopAudioScheduler();
    this.#runBackground(this.#startAudio(timeUs, generation));
  }

  #stopAudioScheduler(): void {
    try {
      this.#audioScheduler?.stop();
    } catch (error) {
      if (!this.#destroyed) this.#reportError(error);
    }
  }

  async #startAudio(startTimeUs: TimeUs, generation: number): Promise<void> {
    this.#audioScheduler ??= this.#audioSchedulerFactory();
    try {
      await this.#audioScheduler.resume();
      if (this.#destroyed || generation !== this.#audioGeneration || !this.#clock.playing) return;
      this.#audioScheduler.startTransport(startTimeUs);
      this.#audioTransportGeneration = generation;
      this.#audioScheduledUntilUs = startTimeUs;
      this.#audioStartingGeneration = null;
      await this.#scheduleAudioWindow(startTimeUs, timeUs(startTimeUs + 1_800_000), generation);
    } finally {
      if (this.#audioStartingGeneration === generation) this.#audioStartingGeneration = null;
    }
  }

  async #scheduleAudioWindow(fromUs: TimeUs, toUs: TimeUs, generation: number): Promise<void> {
    if (
      !this.#audioScheduler ||
      toUs <= fromUs ||
      generation !== this.#audioGeneration ||
      this.#audioTransportGeneration !== generation ||
      !this.#clock.playing
    )
      return;
    this.#audioSchedulingGeneration = generation;
    this.#audioScheduledUntilUs = toUs;
    try {
      const sequence = getSequence(this.#project);
      const assets = new Map(this.#project.assets.map((asset) => [asset.id, asset]));
      const work: Promise<void>[] = [];
      for (const track of sequence.tracks) {
        if (track.muted) continue;
        for (const clip of track.clips) {
          const asset = assets.get(clip.assetId);
          if (
            !asset ||
            !clipCarriesAudio(asset, clip, track) ||
            clipEndUs(clip) <= fromUs ||
            clip.timelineStartUs >= toUs
          )
            continue;
          const timelineFromUs = timeUs(Math.max(fromUs, clip.timelineStartUs));
          const timelineToUs = timeUs(Math.min(toUs, clipEndUs(clip)));
          const sourceFromUs = timeUs(clip.sourceStartUs + timelineFromUs - clip.timelineStartUs);
          const source = this.#source(this.#sourceResolver.resolve(asset.id));
          if (!source.buffers) continue;
          work.push(
            this.#audioScheduler.schedule(
              source as VideoSource & AudioSource,
              sourceFromUs,
              timelineFromUs,
              timeUs(timelineToUs - timelineFromUs),
              {
                timelineStartUs: clip.timelineStartUs,
                timelineEndUs: clipEndUs(clip),
                fadeInUs: clip.fadeInUs ?? timeUs(0),
                fadeOutUs: clip.fadeOutUs ?? timeUs(0),
              },
            ),
          );
        }
      }
      await Promise.all(work);
    } catch (error) {
      if (this.#audioTransportGeneration === generation) this.#audioTransportGeneration = null;
      throw error;
    } finally {
      if (this.#audioSchedulingGeneration === generation) this.#audioSchedulingGeneration = null;
    }
  }

  #runBackground<T>(promise: Promise<T>): void {
    void promise.catch((error: unknown) => {
      if (!this.#destroyed) this.#reportError(error);
    });
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Error observers must not create a second unhandled rejection.
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
      playbackRate: this.#clock.playing ? this.#clock.rate : 0,
      activeAssetId: this.#lastActiveAssetId,
      activeSourceKind: this.#lastActiveSourceKind,
      foregroundPressure: this.#clock.playing
        ? "playing"
        : this.#mode.kind === "asset"
          ? "hover-skimming"
          : executor.inFlight || this.#playbackFrameInFlight
            ? "seeking"
            : "idle",
      renderFps: Math.round(this.#renderedSinceSnapshot / elapsedSeconds),
      targetFps: sequence.frameRate,
      droppedFrames: this.#droppedFrames,
      frameOperationsInFlight: executor.inFlight + (this.#playbackFrameInFlight ? 1 : 0),
      newestRequestPending: executor.pending > 0,
      requestsReceived: executor.received + this.#playbackRequests,
      requestsCoalesced: executor.coalesced,
      framesPresented: executor.completed + this.#playbackFramesPresented,
      framesObsolete: executor.obsolete + this.#playbackFramesObsolete,
      failedRequests: executor.failed + this.#playbackFailedRequests,
      activeSources: this.#sources.size,
      activeClips: resolveScene(this.#project, timelineTimeUs).length,
      seekLatencyMs: this.#seekLatencyMs,
      gpuSubmitCpuMs: compositor.gpuSubmitCpuMs,
      gpuSubmittedFrames: compositor.submittedFrames,
      gpuDeviceLostCount: compositor.deviceLostCount,
      previewWidth: sequence.width,
      previewHeight: sequence.height,
      sourcePreviewSuppressions: this.#sourcePreviewSuppressions,
      masterPeakDb: this.#audioScheduler?.samplePeakDb?.() ?? [-60, -60],
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
    this.#resetSequentialCursors();
    for (const source of this.#sources.values()) source.destroy();
    this.#sources.clear();
    this.#listeners.clear();
    if (this.#audioScheduler)
      void this.#audioScheduler.destroy().catch((error: unknown) => this.#reportError(error));
    this.#audioScheduler = null;
  }
}

import { clipEndUs, getSequence, sequenceDurationUs } from "@cinesim/core";
import type { AssetId, Project, TimeUs } from "@cinesim/core";
import { MediabunnyWebCodecsSource } from "../media/mediabunny-source";
import { WebAudioScheduler } from "../playback/audio-scheduler";
import { MonotonicPlaybackClock } from "../playback/clock";
import { findUpcomingLayers, resolveScene } from "../playback/scene-resolver";
import { LatestRequestController } from "../playback/latest-request";
import type { WebGpuCompositor } from "../compositor/webgpu-compositor";

export interface RuntimeSnapshot {
  timeUs: TimeUs;
  playing: boolean;
  renderFps: number;
  droppedFrames: number;
  decodeQueueSize: number;
  activeDecoders: number;
  activeClips: number;
  seekLatencyMs: number;
  gpuFrameTimeMs: number;
  previewWidth: number;
  previewHeight: number;
}

export class PlaybackRuntime {
  #project: Project;
  readonly #compositor: WebGpuCompositor;
  readonly #clock = new MonotonicPlaybackClock();
  readonly #sources = new Map<AssetId, MediabunnyWebCodecsSource>();
  readonly #listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  readonly #seekController: LatestRequestController<TimeUs, void>;
  #animationFrame = 0;
  #lastSnapshotAt = 0;
  #renderedSinceSnapshot = 0;
  #droppedFrames = 0;
  #seekLatencyMs = 0;
  #rendering = false;
  #audioScheduler: WebAudioScheduler | null = null;
  #audioScheduledUntilUs: TimeUs = 0;
  #audioScheduling = false;

  constructor(project: Project, compositor: WebGpuCompositor) {
    this.#project = project;
    this.#compositor = compositor;
    this.#seekController = new LatestRequestController(async (timeUs) => {
      const start = performance.now();
      this.#clock.seek(timeUs);
      await Promise.all([...this.#sources.values()].map((source) => source.seek(timeUs)));
      await this.#renderAt(timeUs);
      if (this.#clock.playing) void this.#startAudio(timeUs);
      this.#seekLatencyMs = performance.now() - start;
    });
  }

  setProject(project: Project): void {
    this.#project = project;
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot());
    return () => this.#listeners.delete(listener);
  }

  play(): void {
    if (this.#clock.playing) return;
    this.#clock.play();
    void this.#startAudio(this.#clock.now());
    this.#tick();
  }

  pause(): void {
    this.#clock.pause();
    this.#audioScheduler?.stop();
    cancelAnimationFrame(this.#animationFrame);
    this.#emit();
  }

  async seek(timeUs: TimeUs): Promise<void> {
    await this.#seekController.run(timeUs);
    this.#emit();
  }

  #source(assetId: AssetId): MediabunnyWebCodecsSource {
    let source = this.#sources.get(assetId);
    if (!source) {
      source = new MediabunnyWebCodecsSource(`cinesim-media://asset/${assetId}`);
      this.#sources.set(assetId, source);
    }
    return source;
  }

  #tick = (): void => {
    if (!this.#clock.playing) return;
    const duration = sequenceDurationUs(getSequence(this.#project));
    const timeUs = Math.min(this.#clock.now(), duration);
    if (timeUs >= duration) {
      this.pause();
      return;
    }
    if (this.#rendering) this.#droppedFrames += 1;
    else void this.#renderAt(timeUs);
    if (this.#audioScheduledUntilUs - timeUs < 700_000 && !this.#audioScheduling)
      void this.#scheduleAudioWindow(this.#audioScheduledUntilUs, timeUs + 1_800_000);
    if (performance.now() - this.#lastSnapshotAt > 80) this.#emit();
    this.#animationFrame = requestAnimationFrame(this.#tick);
  };

  async #renderAt(timeUs: TimeUs): Promise<void> {
    this.#rendering = true;
    try {
      const layers = resolveScene(this.#project, timeUs);
      const frames = await Promise.all(
        layers.map(async (layer) => ({
          frame: await this.#source(layer.asset.id).getFrame(layer.sourceTimeUs),
          transform: layer.clip.transform,
        })),
      );
      this.#compositor.render(
        frames.flatMap((layer) =>
          layer.frame ? [{ frame: layer.frame, transform: layer.transform }] : [],
        ),
      );
      this.#renderedSinceSnapshot += 1;
      for (const upcoming of findUpcomingLayers(this.#project, timeUs)) {
        void this.#source(upcoming.asset.id).prepare();
      }
    } finally {
      this.#rendering = false;
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
          work.push(
            this.#audioScheduler.schedule(
              this.#source(asset.id),
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
    const now = performance.now();
    const elapsedSeconds = Math.max((now - this.#lastSnapshotAt) / 1_000, 0.001);
    const sequence = getSequence(this.#project);
    const snapshot: RuntimeSnapshot = {
      timeUs: this.#clock.now(),
      playing: this.#clock.playing,
      renderFps: Math.round(this.#renderedSinceSnapshot / elapsedSeconds),
      droppedFrames: this.#droppedFrames,
      decodeQueueSize: this.#rendering ? 1 : 0,
      activeDecoders: this.#sources.size,
      activeClips: resolveScene(this.#project, this.#clock.now()).length,
      seekLatencyMs: this.#seekLatencyMs,
      gpuFrameTimeMs: this.#compositor.metrics.gpuFrameTimeMs,
      previewWidth: sequence.width,
      previewHeight: sequence.height,
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
    this.pause();
    this.#seekController.invalidate();
    for (const source of this.#sources.values()) source.destroy();
    this.#sources.clear();
    this.#listeners.clear();
    if (this.#audioScheduler) void this.#audioScheduler.destroy();
    this.#audioScheduler = null;
  }
}

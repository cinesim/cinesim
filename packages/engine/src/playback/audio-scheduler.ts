import { secondsToTimeUs, timeSeconds, timeUs, timeUsToSeconds } from "@cinesim/core";
import type { TimeUs } from "@cinesim/core";
import type { AudioBufferChunk, AudioSource } from "../media/video-source";

export interface PlaybackAudioScheduler {
  startTransport(timelineUs: TimeUs): void;
  schedule(
    source: AudioSource,
    sourceFromUs: TimeUs,
    timelineFromUs: TimeUs,
    durationUs?: TimeUs,
    envelope?: AudioFadeEnvelope,
  ): Promise<void>;
  samplePeakDb?(): readonly [number, number];
  resume(): Promise<void>;
  stop(): void;
  destroy(): Promise<void>;
}

export interface AudioFadeEnvelope {
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
  fadeInUs: TimeUs;
  fadeOutUs: TimeUs;
  gain?: number;
}

interface ScheduledAudioNode {
  gain: GainNode;
  node: AudioBufferSourceNode;
}

export function audioFadeGainAt(envelope: AudioFadeEnvelope, timelineUs: TimeUs): number {
  const durationUs = Math.max(0, envelope.timelineEndUs - envelope.timelineStartUs);
  const elapsedUs = timelineUs - envelope.timelineStartUs;
  if (durationUs === 0 || elapsedUs < 0 || elapsedUs > durationUs) return 0;
  const fadeInUs = Math.min(durationUs, Math.max(0, envelope.fadeInUs));
  const fadeOutUs = Math.min(durationUs, Math.max(0, envelope.fadeOutUs));
  const fadeInGain = fadeInUs > 0 ? Math.min(1, elapsedUs / fadeInUs) : 1;
  const fadeOutGain = fadeOutUs > 0 ? Math.min(1, (durationUs - elapsedUs) / fadeOutUs) : 1;
  return Math.max(0, Math.min(fadeInGain, fadeOutGain)) * (envelope.gain ?? 1);
}

export class WebAudioScheduler implements PlaybackAudioScheduler {
  readonly #context: AudioContext;
  readonly #master: GainNode;
  readonly #analysers: readonly [AnalyserNode, AnalyserNode];
  readonly #meterSamples: readonly [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>];
  #scheduled = new Set<ScheduledAudioNode>();
  #generation = 0;
  #transportTimelineUs: TimeUs = timeUs(0);
  #transportContextTime = 0;

  constructor(context = new AudioContext({ latencyHint: "interactive" })) {
    this.#context = context;
    this.#master = context.createGain();
    this.#master.channelCount = 2;
    this.#master.channelCountMode = "explicit";
    this.#master.channelInterpretation = "speakers";
    this.#master.connect(context.destination);
    const splitter = context.createChannelSplitter(2);
    const silent = context.createGain();
    silent.gain.value = 0;
    silent.connect(context.destination);
    this.#master.connect(splitter);
    const left = context.createAnalyser();
    const right = context.createAnalyser();
    left.fftSize = 4096;
    right.fftSize = 4096;
    left.smoothingTimeConstant = 0.4;
    right.smoothingTimeConstant = 0.4;
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    left.connect(silent);
    right.connect(silent);
    this.#analysers = [left, right];
    this.#meterSamples = [new Float32Array(left.fftSize), new Float32Array(right.fftSize)];
  }

  get currentTimeUs(): TimeUs {
    return secondsToTimeUs(timeSeconds(this.#context.currentTime));
  }

  startTransport(timelineUs: TimeUs): void {
    this.stop();
    this.#transportTimelineUs = timelineUs;
    this.#transportContextTime = this.#context.currentTime + 0.05;
  }

  async schedule(
    source: AudioSource,
    sourceFromUs: TimeUs,
    timelineFromUs: TimeUs,
    durationUs = timeUs(1_500_000),
    envelope?: AudioFadeEnvelope,
  ): Promise<void> {
    const generation = this.#generation;
    for await (const chunk of source.buffers(sourceFromUs, timeUs(sourceFromUs + durationUs))) {
      if (generation !== this.#generation) return;
      const timing = audioChunkTiming(chunk, {
        sourceFromUs,
        timelineFromUs,
        durationUs,
        contextTime: this.#context.currentTime,
        transportTimelineUs: this.#transportTimelineUs,
        transportContextTime: this.#transportContextTime,
      });
      if (timing) this.#scheduleChunk(chunk, timing, envelope);
    }
  }

  #scheduleChunk(
    chunk: AudioBufferChunk,
    timing: ScheduledAudioTiming,
    envelope: AudioFadeEnvelope | undefined,
  ): void {
    const node = this.#context.createBufferSource();
    node.buffer = chunk.buffer;
    const gain = this.#context.createGain();
    node.connect(gain);
    gain.connect(this.#master);
    const scheduled = { gain, node };
    node.onended = () => this.#release(scheduled);
    if (envelope)
      scheduleFadeAutomation(
        gain.gain,
        timing.startAt,
        timing.timelineStartUs,
        timing.timelineEndUs,
        envelope,
      );
    try {
      node.start(timing.startAt, timing.bufferOffsetSeconds, timing.playbackDurationSeconds);
      this.#scheduled.add(scheduled);
    } catch (error) {
      this.#release(scheduled);
      throw error;
    }
  }

  samplePeakDb(): readonly [number, number] {
    return this.#analysers.map((analyser, index) => {
      const samples = this.#meterSamples[index as 0 | 1];
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      return peak > 0 ? Math.max(-60, 20 * Math.log10(peak)) : -60;
    }) as unknown as readonly [number, number];
  }

  async resume(): Promise<void> {
    await this.#context.resume();
  }

  stop(): void {
    this.#generation += 1;
    const scheduled = [...this.#scheduled];
    this.#scheduled.clear();
    for (const entry of scheduled) {
      entry.node.onended = null;
      try {
        entry.node.stop();
      } catch {
        // Cleanup must remain safe if the browser has already invalidated a source node.
      }
      this.#disconnect(entry);
    }
  }

  async destroy(): Promise<void> {
    this.stop();
    await this.#context.close();
  }

  #release(scheduled: ScheduledAudioNode): void {
    this.#scheduled.delete(scheduled);
    scheduled.node.onended = null;
    this.#disconnect(scheduled);
  }

  #disconnect({ gain, node }: ScheduledAudioNode): void {
    try {
      node.disconnect();
    } catch {
      // The node may already be disconnected during overlapping cleanup.
    }
    try {
      gain.disconnect();
    } catch {
      // The gain may already be disconnected during overlapping cleanup.
    }
  }
}

interface ScheduledAudioTiming {
  startAt: number;
  bufferOffsetSeconds: number;
  playbackDurationSeconds: number;
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
}

interface AudioChunkTimingContext {
  sourceFromUs: TimeUs;
  timelineFromUs: TimeUs;
  durationUs: TimeUs;
  contextTime: number;
  transportTimelineUs: TimeUs;
  transportContextTime: number;
}

function audioChunkTiming(
  chunk: AudioBufferChunk,
  context: AudioChunkTimingContext,
): ScheduledAudioTiming | null {
  const chunkDurationUs = secondsToTimeUs(timeSeconds(chunk.buffer.duration));
  const sourceToUs = context.sourceFromUs + context.durationUs;
  const audibleStartUs = Math.max(context.sourceFromUs, chunk.timestampUs);
  const audibleEndUs = Math.min(sourceToUs, chunk.timestampUs + chunkDurationUs);
  if (audibleEndUs <= audibleStartUs) return null;
  const timelineStartUs = context.timelineFromUs + audibleStartUs - context.sourceFromUs;
  const timelineEndUs = context.timelineFromUs + audibleEndUs - context.sourceFromUs;
  const desiredStartAt =
    context.transportContextTime + (timelineStartUs - context.transportTimelineUs) / 1_000_000;
  const lateByUs = Math.max(0, Math.round((context.contextTime - desiredStartAt) * 1_000_000));
  const effectiveStartUs = audibleStartUs + lateByUs;
  if (effectiveStartUs >= audibleEndUs) return null;
  return {
    startAt: Math.max(context.contextTime, desiredStartAt),
    bufferOffsetSeconds: (effectiveStartUs - chunk.timestampUs) / 1_000_000,
    playbackDurationSeconds: (audibleEndUs - effectiveStartUs) / 1_000_000,
    timelineStartUs: timeUs(context.timelineFromUs + effectiveStartUs - context.sourceFromUs),
    timelineEndUs: timeUs(timelineEndUs),
  };
}

function scheduleFadeAutomation(
  gain: AudioParam,
  contextStart: number,
  timelineStartUs: TimeUs,
  timelineEndUs: TimeUs,
  envelope: AudioFadeEnvelope,
): void {
  const points = [
    timelineStartUs,
    timeUs(envelope.timelineStartUs + envelope.fadeInUs),
    timeUs(envelope.timelineEndUs - envelope.fadeOutUs),
    timelineEndUs,
  ]
    .filter((timeUs) => timeUs >= timelineStartUs && timeUs <= timelineEndUs)
    .sort((left, right) => left - right)
    .filter((timeUs, index, values) => index === 0 || timeUs !== values[index - 1]);
  const firstUs = points[0] ?? timelineStartUs;
  gain.setValueAtTime(audioFadeGainAt(envelope, firstUs), contextStart);
  for (const pointUs of points.slice(1)) {
    gain.linearRampToValueAtTime(
      audioFadeGainAt(envelope, pointUs),
      contextStart + timeUsToSeconds(timeUs(pointUs - timelineStartUs)),
    );
  }
}

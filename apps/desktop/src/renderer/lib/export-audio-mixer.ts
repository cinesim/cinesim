import { timeUs, type AssetId, type TimeUs } from "@cinesim/core";
import {
  MediabunnyWebCodecsSource,
  type AudioBufferChunk,
  type AudioSource,
  type MediaSourceResolver,
} from "@cinesim/engine";
import { createAudioPlan, findIrComposition, type IrProgram } from "@cinesim/ir";

const AUTOMATION_FRAMES = 64;

interface ControlSource {
  clipId: string;
  assetId: string;
  sourceTimeUs: number;
  gain: number;
  pan: number;
}

interface ControlInterval {
  fromFrame: number;
  toFrame: number;
  from: Map<string, ControlSource>;
  to: Map<string, ControlSource>;
}

interface DecodedClipWindow {
  assetId: string;
  fromUs: number;
  toUs: number;
  chunks: AudioBufferChunk[];
}

function frameTimeUs(rangeStartUs: number, frame: number, sampleRate: number): number {
  return Math.round(rangeStartUs + (frame * 1_000_000) / sampleRate);
}

function audioBoundaries(program: IrProgram, fromUs: number, toUs: number): number[] {
  const composition = findIrComposition(program);
  const clipBoundaries = composition.timeline.tracks.flatMap((track) =>
    track.kind === "audio"
      ? track.clips.flatMap((clip) => [
          clip.timelineStartUs,
          clip.timelineStartUs + clip.durationUs,
        ])
      : [],
  );
  const transitionBoundaries = composition.timeline.audioTransitions.flatMap((transition) => {
    const incoming = composition.timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === transition.toClipId);
    return incoming
      ? [incoming.timelineStartUs - transition.durationUs, incoming.timelineStartUs]
      : [];
  });
  return [...clipBoundaries, ...transitionBoundaries].filter(
    (time) => time > fromUs && time < toUs,
  );
}

function controlFrames(
  program: IrProgram,
  fromUs: number,
  toUs: number,
  frameCount: number,
  sampleRate: number,
): number[] {
  const frames = new Set<number>([0, frameCount]);
  for (let frame = AUTOMATION_FRAMES; frame < frameCount; frame += AUTOMATION_FRAMES)
    frames.add(frame);
  for (const boundary of audioBoundaries(program, fromUs, toUs)) {
    frames.add(
      Math.max(0, Math.min(frameCount, Math.round(((boundary - fromUs) * sampleRate) / 1e6))),
    );
  }
  return [...frames].sort((left, right) => left - right);
}

function planSources(program: IrProgram, atUs: number): Map<string, ControlSource> {
  return new Map(
    createAudioPlan(program, atUs).sources.map((source) => [
      source.clipId,
      {
        clipId: source.clipId,
        assetId: source.assetId,
        sourceTimeUs: source.sourceTimeUs,
        gain: source.gain,
        pan: source.pan,
      },
    ]),
  );
}

function controlIntervals(
  program: IrProgram,
  fromUs: number,
  toUs: number,
  frameCount: number,
  sampleRate: number,
): ControlInterval[] {
  const frames = controlFrames(program, fromUs, toUs, frameCount, sampleRate);
  return frames.slice(0, -1).map((fromFrame, index) => {
    const toFrame = frames[index + 1]!;
    const lastFrame = Math.max(fromFrame, toFrame - 1);
    return {
      fromFrame,
      toFrame,
      from: planSources(program, frameTimeUs(fromUs, fromFrame, sampleRate)),
      to: planSources(program, frameTimeUs(fromUs, lastFrame, sampleRate)),
    };
  });
}

function decodedRanges(intervals: readonly ControlInterval[]): Map<string, DecodedClipWindow> {
  const result = new Map<string, DecodedClipWindow>();
  for (const interval of intervals) {
    for (const source of [...interval.from.values(), ...interval.to.values()]) {
      const existing = result.get(source.clipId);
      if (existing) {
        existing.fromUs = Math.min(existing.fromUs, source.sourceTimeUs);
        existing.toUs = Math.max(existing.toUs, source.sourceTimeUs);
      } else {
        result.set(source.clipId, {
          assetId: source.assetId,
          fromUs: source.sourceTimeUs,
          toUs: source.sourceTimeUs,
          chunks: [],
        });
      }
    }
  }
  return result;
}

async function decodeRanges(
  ranges: Map<string, DecodedClipWindow>,
  source: (assetId: string) => AudioSource,
): Promise<void> {
  for (const range of ranges.values()) {
    const paddingUs = 100_000;
    const fromUs = timeUs(Math.max(0, Math.floor(range.fromUs - paddingUs)));
    const toUs = timeUs(Math.max(fromUs + 1, Math.ceil(range.toUs + paddingUs)));
    for await (const chunk of source(range.assetId).buffers(fromUs, toUs)) range.chunks.push(chunk);
  }
}

function channelSample(chunk: AudioBufferChunk, channel: number, sourceUs: number): number {
  const data = chunk.buffer.getChannelData(Math.min(channel, chunk.buffer.numberOfChannels - 1));
  const position = ((sourceUs - chunk.timestampUs) * chunk.buffer.sampleRate) / 1_000_000;
  const leftIndex = Math.max(0, Math.min(data.length - 1, Math.floor(position)));
  const rightIndex = Math.min(data.length - 1, leftIndex + 1);
  const progress = Math.max(0, Math.min(1, position - leftIndex));
  return data[leftIndex]! + (data[rightIndex]! - data[leftIndex]!) * progress;
}

function sampleAt(range: DecodedClipWindow, channel: number, sourceUs: number): number {
  const chunk = range.chunks.find(
    (candidate) =>
      sourceUs >= candidate.timestampUs && sourceUs < candidate.timestampUs + candidate.durationUs,
  );
  return chunk ? channelSample(chunk, channel, sourceUs) : 0;
}

function interpolated(left: number, right: number, progress: number): number {
  return left + (right - left) * progress;
}

function mixSource(
  output: readonly [Float32Array, Float32Array],
  range: DecodedClipWindow,
  from: ControlSource,
  to: ControlSource,
  interval: ControlInterval,
): void {
  const frameSpan = Math.max(1, interval.toFrame - interval.fromFrame - 1);
  const left = output[0];
  const right = output[1];
  for (let frame = interval.fromFrame; frame < interval.toFrame; frame += 1) {
    const progress = (frame - interval.fromFrame) / frameSpan;
    const sourceUs = interpolated(from.sourceTimeUs, to.sourceTimeUs, progress);
    const gain = interpolated(from.gain, to.gain, progress);
    const pan = interpolated(from.pan, to.pan, progress);
    left[frame] =
      (left[frame] ?? 0) + sampleAt(range, 0, sourceUs) * gain * (pan > 0 ? 1 - pan : 1);
    right[frame] =
      (right[frame] ?? 0) + sampleAt(range, 1, sourceUs) * gain * (pan < 0 ? 1 + pan : 1);
  }
}

function mixIntervals(
  intervals: readonly ControlInterval[],
  ranges: ReadonlyMap<string, DecodedClipWindow>,
  frameCount: number,
): readonly [Float32Array, Float32Array] {
  const output: [Float32Array, Float32Array] = [
    new Float32Array(frameCount),
    new Float32Array(frameCount),
  ];
  for (const interval of intervals) {
    const ids = new Set([...interval.from.keys(), ...interval.to.keys()]);
    for (const id of ids) {
      const from = interval.from.get(id) ?? interval.to.get(id);
      const to = interval.to.get(id) ?? interval.from.get(id);
      const range = ranges.get(id);
      if (from && to && range) mixSource(output, range, from, to, interval);
    }
  }
  for (const channel of output)
    for (let index = 0; index < channel.length; index += 1)
      channel[index] = Math.max(-1, Math.min(1, channel[index]!));
  return output;
}

/** Mixes a bounded timeline range without constructing a browser AudioBuffer. */
export async function mixExportAudioChannels(input: {
  program: IrProgram;
  fromUs: TimeUs;
  toUs: TimeUs;
  sampleRate: number;
  source: (assetId: string) => AudioSource;
}): Promise<readonly [Float32Array, Float32Array]> {
  const frameCount = Math.max(
    1,
    Math.round(((input.toUs - input.fromUs) * input.sampleRate) / 1_000_000),
  );
  const intervals = controlIntervals(
    input.program,
    input.fromUs,
    input.toUs,
    frameCount,
    input.sampleRate,
  );
  const ranges = decodedRanges(intervals);
  await decodeRanges(ranges, input.source);
  return mixIntervals(intervals, ranges, frameCount);
}

export class ExportAudioMixer {
  readonly #sources = new Map<string, MediabunnyWebCodecsSource>();

  constructor(
    private readonly program: IrProgram,
    private readonly resolver: MediaSourceResolver,
    private readonly sampleRate = 48_000,
  ) {}

  async render(fromUs: TimeUs, toUs: TimeUs): Promise<AudioBuffer> {
    const channels = await mixExportAudioChannels({
      program: this.program,
      fromUs,
      toUs,
      sampleRate: this.sampleRate,
      source: (assetId) => this.#source(assetId),
    });
    const frameCount = channels[0].length;
    const buffer = new AudioBuffer({
      length: frameCount,
      numberOfChannels: 2,
      sampleRate: this.sampleRate,
    });
    buffer.getChannelData(0).set(channels[0]);
    buffer.getChannelData(1).set(channels[1]);
    return buffer;
  }

  destroy(): void {
    for (const source of this.#sources.values()) source.destroy();
    this.#sources.clear();
  }

  #source(assetId: string): MediabunnyWebCodecsSource {
    let source = this.#sources.get(assetId);
    if (source) return source;
    source = new MediabunnyWebCodecsSource(this.resolver.resolveOriginal(assetId as AssetId).url);
    this.#sources.set(assetId, source);
    return source;
  }
}

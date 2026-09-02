import { timeUs, type Project, type ProjectSettings } from "@cinesim/core";
import { PlaybackRuntime, WebGpuCompositor, type MediaSourceResolver } from "@cinesim/engine";
import type { IrProgram } from "@cinesim/ir";
import {
  AudioBufferSource,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";
import type {
  DerivedProjectScope,
  ExportRenderCompletion,
  ExportRenderRequest,
} from "../../shared/contracts";
import { ExportAudioMixer } from "./export-audio-mixer";
import { ProxySourceResolver } from "./proxy-source-resolver";

const AUDIO_CHUNK_US = 500_000;

function assertNotCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Export canceled", "AbortError");
}

function originalResolver(scope: DerivedProjectScope): MediaSourceResolver {
  const resolver = new ProxySourceResolver(scope, () => null);
  return {
    resolve: (assetId) => resolver.resolveOriginal(assetId),
    resolveOriginal: (assetId) => resolver.resolveOriginal(assetId),
  };
}

function exportWritable(jobId: string): {
  writable: WritableStream<StreamTargetChunk>;
  bytes: () => number;
} {
  let maxEnd = 0;
  return {
    writable: new WritableStream<StreamTargetChunk>({
      async write(chunk) {
        const data = chunk.data.slice();
        maxEnd = Math.max(maxEnd, chunk.position + data.byteLength);
        await window.cinesim.exports.writeChunk(jobId, chunk.position, data);
      },
    }),
    bytes: () => maxEnd,
  };
}

async function encodingSources(canvas: HTMLCanvasElement, request: ExportRenderRequest) {
  const [videoCodec, audioCodec] = await Promise.all([
    getFirstEncodableVideoCodec(["avc"], {
      width: request.job.width,
      height: request.job.height,
      quality: QUALITY_HIGH,
    }),
    getFirstEncodableAudioCodec(["aac"], { quality: QUALITY_HIGH }),
  ]);
  if (!videoCodec) throw new Error("H.264 encoding is unavailable in the active renderer");
  if (!audioCodec) throw new Error("AAC encoding is unavailable in the active renderer");
  return {
    video: new CanvasSource(canvas, {
      codec: videoCodec,
      quality: QUALITY_HIGH,
      keyFrameInterval: 2,
      alpha: "discard",
    }),
    audio: new AudioBufferSource({
      codec: audioCodec,
      quality: QUALITY_HIGH,
      transform: { numberOfChannels: 2, sampleRate: 48_000, sampleFormat: "f32" },
    }),
  };
}

function exportProgram(program: IrProgram, sequenceId: string): IrProgram {
  return { ...program, activeCompositionId: sequenceId };
}

interface EncodingInput {
  playback: PlaybackRuntime;
  compositor: WebGpuCompositor;
  video: CanvasSource;
  audio: AudioBufferSource;
  mixer: ExportAudioMixer;
  request: ExportRenderRequest;
  signal: AbortSignal;
}

function relativeFrameUs(frame: number, frameRate: number): number {
  return Math.round((frame * 1_000_000) / frameRate);
}

async function encodeVideoChunk(
  input: EncodingInput,
  firstFrame: number,
  frameCount: number,
  relativeEndUs: number,
): Promise<number> {
  const { job } = input.request;
  const durationUs = job.endUs - job.startUs;
  let frame = firstFrame;
  while (frame < frameCount && relativeFrameUs(frame, job.frameRate) < relativeEndUs) {
    assertNotCanceled(input.signal);
    const relativeUs = relativeFrameUs(frame, job.frameRate);
    const nextRelativeUs = Math.min(durationUs, relativeFrameUs(frame + 1, job.frameRate));
    await input.playback.seekTimeline(timeUs(job.startUs + relativeUs));
    await input.compositor.waitForSubmittedWork();
    await input.video.add(relativeUs / 1_000_000, (nextRelativeUs - relativeUs) / 1_000_000, {
      keyFrame: frame === 0 || frame % Math.max(1, Math.round(job.frameRate * 2)) === 0,
    });
    frame += 1;
  }
  return frame;
}

async function encodeRange(
  input: EncodingInput,
): Promise<{ videoFrames: number; audioFrames: number }> {
  const { job } = input.request;
  const durationUs = job.endUs - job.startUs;
  const frameCount = Math.max(1, Math.ceil((durationUs * job.frameRate) / 1_000_000));
  let videoFrames = 0;
  let audioFrames = 0;
  for (let offsetUs = 0; offsetUs < durationUs; offsetUs += AUDIO_CHUNK_US) {
    const relativeEndUs = Math.min(durationUs, offsetUs + AUDIO_CHUNK_US);
    videoFrames = await encodeVideoChunk(input, videoFrames, frameCount, relativeEndUs);
    assertNotCanceled(input.signal);
    const buffer = await input.mixer.render(
      timeUs(job.startUs + offsetUs),
      timeUs(job.startUs + relativeEndUs),
    );
    await input.audio.add(buffer);
    audioFrames += buffer.length;
    await window.cinesim.exports.updateProgress(job.id, (relativeEndUs / durationUs) * 0.98);
  }
  input.video.close();
  input.audio.close();
  return { videoFrames, audioFrames };
}

/** Encodes one explicit accepted-IR range through the production compositor and bounded audio mixer. */
export async function renderAcceptedExport(input: {
  project: Project;
  settings: ProjectSettings;
  program: IrProgram;
  request: ExportRenderRequest;
  signal: AbortSignal;
}): Promise<ExportRenderCompletion> {
  const canvas = document.createElement("canvas");
  const compositor = new WebGpuCompositor(canvas, { autoResize: false });
  compositor.setOutputSize(input.request.job.width, input.request.job.height);
  const resolver = originalResolver(input.request.projectScope);
  const program = exportProgram(input.program, input.request.job.sequenceId);
  const playback = new PlaybackRuntime(
    { program, assets: input.project.assets, colorPolicy: input.settings },
    compositor,
    { sourceResolver: resolver },
  );
  const mixer = new ExportAudioMixer(program, resolver);
  const target = exportWritable(input.request.job.id);
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
    target: new StreamTarget(target.writable, { chunked: true, chunkSize: 1024 * 1024 }),
  });
  let finalized = false;
  try {
    assertNotCanceled(input.signal);
    await playback.initialize();
    const sources = await encodingSources(canvas, input.request);
    output.addVideoTrack(sources.video, { name: "Cinesim picture" });
    output.addAudioTrack(sources.audio, { name: "Cinesim mix" });
    await output.start();
    const encoded = await encodeRange({
      playback,
      compositor,
      video: sources.video,
      audio: sources.audio,
      mixer,
      request: input.request,
      signal: input.signal,
    });
    await output.finalize();
    finalized = true;
    return { jobId: input.request.job.id, bytes: target.bytes(), ...encoded };
  } finally {
    if (!finalized && output.state !== "canceled" && output.state !== "finalized")
      await output.cancel().catch(() => undefined);
    mixer.destroy();
    playback.destroy();
    compositor.destroy();
  }
}

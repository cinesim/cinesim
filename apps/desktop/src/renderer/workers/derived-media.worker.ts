/// <reference lib="webworker" />

import {
  filmstripSampleTimes,
  nearestSampleIndex,
  scoreThumbnailRgba,
  thumbnailCandidateTimes,
} from "@cinesim/engine";
import { timeUs, type TimeUs } from "@cinesim/core";
import {
  ALL_FORMATS,
  AudioSampleSink,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  StreamTarget,
  UrlSource,
  WavOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import type { StreamTargetChunk } from "mediabunny";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "../lib/derived-worker-api";
import { originalMediaUrl } from "../lib/media-url";
import {
  encodeWaveformEnvelope,
  WAVEFORM_FORMAT_VERSION,
  waveformPeakCount,
} from "../../shared/waveform-format";
import { accumulateWaveformSample } from "../lib/waveform-sampling";

const scope = self as DedicatedWorkerGlobalScope;
const canceled = new Set<string>();
const chunkAcks = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
const transcriptChunkAcks = new Map<
  number,
  { resolve: () => void; reject: (error: Error) => void }
>();
let activeProxy: {
  jobId: string;
  conversion: Conversion | null;
  pauseController: AbortController | null;
  paused: boolean;
  resume: (() => void) | null;
} | null = null;
let activePerception: {
  jobId: string;
  paused: boolean;
  resume: (() => void) | null;
} | null = null;
let activeTranscript: {
  jobId: string;
  conversion: Conversion | null;
  pauseController: AbortController | null;
  paused: boolean;
  resume: (() => void) | null;
} | null = null;
let nextChunkId = 1;
const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_HEIGHT = 270;
const TILE_WIDTH = 160;
const TILE_HEIGHT = 90;
const COLUMNS = 8;

type GenerateRequest = Extract<DerivedWorkerRequest, { type: "generate" }>;
type FrameRequest = Extract<DerivedWorkerRequest, { type: "frame" }>;
type ProxyRequest = Extract<DerivedWorkerRequest, { type: "proxy" }>;
type TranscriptRequest = Extract<DerivedWorkerRequest, { type: "transcript" }>;
type VideoTrack = NonNullable<Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>>;
type AudioTrack = NonNullable<Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>>;

function post(message: DerivedWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function progress(
  jobId: string,
  stage: "thumbnail" | "filmstrip" | "waveform",
  value: number,
): void {
  post({ type: "progress", jobId, stage, progress: Math.min(1, Math.max(0, value)) });
}

function activity(
  jobId: string,
  stage: Extract<DerivedWorkerResponse, { type: "activity" }>["stage"],
  started: number,
  samples?: { completedSamples: number; totalSamples: number },
): void {
  post({
    type: "activity",
    jobId,
    stage,
    elapsedMs: performance.now() - started,
    ...samples,
  });
}

function assertActive(jobId: string): void {
  if (canceled.has(jobId)) throw new DOMException("Derived job canceled", "AbortError");
}

function mediaInput(request: { assetId: string; projectScope: GenerateRequest["projectScope"] }) {
  return new Input({
    source: new UrlSource(
      originalMediaUrl({ id: request.assetId as `asset_${string}` }, request.projectScope),
      { maxCacheSize: 32 * 1024 * 1024, parallelism: 1 },
    ),
    formats: ALL_FORMATS,
  });
}

async function perceptionTracks(
  input: Input,
  request: GenerateRequest,
): Promise<{ track: VideoTrack | null; audioTrack: AudioTrack | null }> {
  const needsVideo = request.kinds.some((kind) => kind !== "waveform");
  const needsAudio = request.kinds.includes("waveform");
  const [track, audioTrack] = await Promise.all([
    needsVideo ? input.getPrimaryVideoTrack() : null,
    needsAudio ? input.getPrimaryAudioTrack() : null,
  ]);
  if (needsVideo && !track) throw new Error("source-undecodable");
  if (needsAudio && !audioTrack) throw new Error("source-has-no-audio");
  if (track && !(await track.canDecode())) throw new Error("source-undecodable");
  if (audioTrack && !(await audioTrack.canDecode())) throw new Error("source-audio-undecodable");
  return { track, audioTrack };
}

async function sampleThumbnail(
  request: GenerateRequest,
  track: VideoTrack,
  started: number,
): Promise<TimeUs> {
  const candidateTimesUs = thumbnailCandidateTimes(request.durationUs);
  activity(request.jobId, "thumbnail-sampling", started, {
    completedSamples: 0,
    totalSamples: candidateTimesUs.length,
  });
  const candidateSink = new CanvasSink(track, {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    fit: "contain",
    poolSize: 2,
    decoderOptions: { hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
  });
  const analysis = new OffscreenCanvas(64, 36);
  const analysisContext = analysis.getContext("2d", { willReadFrequently: true });
  const thumbnail = new OffscreenCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const thumbnailContext = thumbnail.getContext("2d");
  if (!analysisContext || !thumbnailContext) throw new Error("canvas-unavailable");
  let bestScore = Number.NEGATIVE_INFINITY;
  let sourceTimeUs = candidateTimesUs[0] ?? timeUs(0);
  let candidateIndex = 0;
  for await (const wrapped of candidateSink.canvasesAtTimestamps(
    candidateTimesUs.map((candidate) => candidate / 1_000_000),
    { verifyKeyPackets: false },
  )) {
    await waitUntilPerceptionResumed(request.jobId);
    assertActive(request.jobId);
    const requestedTimeUs = candidateTimesUs[candidateIndex] ?? timeUs(0);
    candidateIndex += 1;
    if (!wrapped) continue;
    analysisContext.clearRect(0, 0, 64, 36);
    analysisContext.drawImage(wrapped.canvas, 0, 0, 64, 36);
    const pixels = analysisContext.getImageData(0, 0, 64, 36).data;
    const scored = scoreThumbnailRgba(pixels, 64, 36, requestedTimeUs, request.durationUs);
    if (scored.score > bestScore) {
      bestScore = scored.score;
      sourceTimeUs = requestedTimeUs;
      thumbnailContext.clearRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
      thumbnailContext.drawImage(wrapped.canvas, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    }
    progress(request.jobId, "thumbnail", candidateIndex / Math.max(1, candidateTimesUs.length));
  }
  assertActive(request.jobId);
  activity(request.jobId, "thumbnail-encoding", started, {
    completedSamples: candidateIndex,
    totalSamples: candidateTimesUs.length,
  });
  const thumbnailBlob = await thumbnail.convertToBlob({ type: "image/jpeg", quality: 0.84 });
  const thumbnailBytes = await thumbnailBlob.arrayBuffer();
  post(
    { type: "thumbnail-complete", jobId: request.jobId, thumbnail: thumbnailBytes, sourceTimeUs },
    [thumbnailBytes],
  );
  activity(request.jobId, "thumbnail-ready", started, {
    completedSamples: candidateIndex,
    totalSamples: candidateTimesUs.length,
  });
  return sourceTimeUs;
}

function alignFilmstripSample(
  tileTimesUs: TimeUs[],
  sourceTimeUs: TimeUs,
  durationUs: TimeUs,
): void {
  const nearest = nearestSampleIndex(tileTimesUs, sourceTimeUs);
  const spacing = durationUs / Math.max(1, tileTimesUs.length);
  if (Math.abs(tileTimesUs[nearest]! - sourceTimeUs) <= spacing / 2) return;
  tileTimesUs[nearest] = sourceTimeUs;
  tileTimesUs.sort((left, right) => left - right);
}

async function sampleFilmstrip(
  request: GenerateRequest,
  track: VideoTrack,
  sourceTimeUs: TimeUs,
  started: number,
): Promise<void> {
  const tileTimesUs = filmstripSampleTimes(request.durationUs);
  if (tileTimesUs.length === 0) throw new Error("no-video-frames");
  activity(request.jobId, "filmstrip-sampling", started, {
    completedSamples: 0,
    totalSamples: tileTimesUs.length,
  });
  alignFilmstripSample(tileTimesUs, sourceTimeUs, request.durationUs);
  const rows = Math.ceil(tileTimesUs.length / COLUMNS);
  const contactSheet = new OffscreenCanvas(COLUMNS * TILE_WIDTH, rows * TILE_HEIGHT);
  const contactContext = contactSheet.getContext("2d");
  if (!contactContext) throw new Error("canvas-unavailable");
  const filmstripSink = new CanvasSink(track, {
    width: TILE_WIDTH,
    height: TILE_HEIGHT,
    fit: "contain",
    poolSize: 2,
    decoderOptions: { hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
  });
  let tileIndex = 0;
  for await (const wrapped of filmstripSink.canvasesAtTimestamps(
    tileTimesUs.map((candidate) => candidate / 1_000_000),
    { verifyKeyPackets: false },
  )) {
    await waitUntilPerceptionResumed(request.jobId);
    assertActive(request.jobId);
    if (wrapped) {
      const column = tileIndex % COLUMNS;
      const row = Math.floor(tileIndex / COLUMNS);
      contactContext.drawImage(
        wrapped.canvas,
        column * TILE_WIDTH,
        row * TILE_HEIGHT,
        TILE_WIDTH,
        TILE_HEIGHT,
      );
    }
    tileIndex += 1;
    progress(request.jobId, "filmstrip", tileIndex / tileTimesUs.length);
  }
  assertActive(request.jobId);
  activity(request.jobId, "filmstrip-encoding", started, {
    completedSamples: tileIndex,
    totalSamples: tileTimesUs.length,
  });
  const filmstripBlob = await contactSheet.convertToBlob({ type: "image/jpeg", quality: 0.78 });
  const filmstripBytes = await filmstripBlob.arrayBuffer();
  post(
    {
      type: "filmstrip-complete",
      jobId: request.jobId,
      filmstrip: filmstripBytes,
      tileTimesUs,
      columns: COLUMNS,
      rows,
      tileWidth: TILE_WIDTH,
      tileHeight: TILE_HEIGHT,
    },
    [filmstripBytes],
  );
  activity(request.jobId, "filmstrip-ready", started, {
    completedSamples: tileIndex,
    totalSamples: tileTimesUs.length,
  });
}

async function generate(request: GenerateRequest) {
  const started = performance.now();
  activePerception = { jobId: request.jobId, paused: false, resume: null };
  activity(request.jobId, "input-opening", started);
  const input = mediaInput(request);
  try {
    if (!(await input.canRead())) throw new Error("unsupported-container");
    activity(request.jobId, "container-ready", started);
    const { track, audioTrack } = await perceptionTracks(input, request);
    activity(request.jobId, "track-ready", started);
    activity(request.jobId, "decoder-ready", started);

    let sourceTimeUs = request.thumbnailSourceTimeUs ?? timeUs(0);
    if (request.kinds.includes("thumbnail"))
      sourceTimeUs = await sampleThumbnail(request, track!, started);
    if (request.kinds.includes("filmstrip"))
      await sampleFilmstrip(request, track!, sourceTimeUs, started);
    if (request.kinds.includes("waveform")) await generateWaveform(request, audioTrack!, started);
    activity(request.jobId, "completed", started);
    post({
      type: "perception-complete",
      jobId: request.jobId,
      samplingLatencyMs: performance.now() - started,
    });
  } finally {
    input.dispose();
    if (activePerception?.jobId === request.jobId) {
      activePerception.resume?.();
      activePerception = null;
    }
    canceled.delete(request.jobId);
  }
}

async function generateFrame(request: FrameRequest): Promise<void> {
  const input = mediaInput(request);
  try {
    assertActive(request.jobId);
    if (!(await input.canRead())) throw new Error("unsupported-container");
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error("source-undecodable");
    const sink = new CanvasSink(track, {
      width: request.width,
      height: request.height,
      fit: "contain",
      poolSize: 1,
      decoderOptions: { hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
    });
    const wrapped = await sink.getCanvas(request.atUs / 1_000_000, {
      verifyKeyPackets: false,
    });
    assertActive(request.jobId);
    if (!wrapped) throw new Error("no-video-frame");
    const output = new OffscreenCanvas(request.width, request.height);
    const context = output.getContext("2d");
    if (!context) throw new Error("canvas-unavailable");
    context.drawImage(wrapped.canvas, 0, 0, request.width, request.height);
    const blob = await output.convertToBlob({ type: "image/png" });
    const frame = await blob.arrayBuffer();
    assertActive(request.jobId);
    post(
      {
        type: "frame-complete",
        jobId: request.jobId,
        frame,
        renderedTimeUs: timeUs(Math.max(0, Math.round(wrapped.timestamp * 1_000_000))),
        width: request.width,
        height: request.height,
      },
      [frame],
    );
  } finally {
    input.dispose();
    canceled.delete(request.jobId);
  }
}

async function generateWaveform(
  request: Extract<DerivedWorkerRequest, { type: "generate" }>,
  track: NonNullable<Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>>,
  started: number,
): Promise<void> {
  const peakCount = waveformPeakCount(request.durationUs);
  const minima = new Float32Array(peakCount);
  const maxima = new Float32Array(peakCount);
  const durationSeconds = Math.max(request.durationUs / 1_000_000, Number.EPSILON);
  const sink = new AudioSampleSink(track);
  activity(request.jobId, "waveform-decoding", started);
  for await (const sample of sink.samples(0, durationSeconds, { verifyKeyPackets: false })) {
    try {
      await waitUntilPerceptionResumed(request.jobId);
      assertActive(request.jobId);
      accumulateWaveformSample(sample, durationSeconds, minima, maxima);
      progress(
        request.jobId,
        "waveform",
        Math.min(0.99, Math.max(0, (sample.timestamp + sample.duration) / durationSeconds)),
      );
    } finally {
      sample.close();
    }
  }
  assertActive(request.jobId);
  activity(request.jobId, "waveform-encoding", started);
  const waveform = encodeWaveformEnvelope(minima, maxima);
  post(
    {
      type: "waveform-complete",
      jobId: request.jobId,
      waveform,
      peakCount,
      waveformFormatVersion: WAVEFORM_FORMAT_VERSION,
    },
    [waveform],
  );
  progress(request.jobId, "waveform", 1);
  activity(request.jobId, "waveform-ready", started, {
    completedSamples: peakCount,
    totalSamples: peakCount,
  });
}

async function waitUntilPerceptionResumed(jobId: string): Promise<void> {
  if (!activePerception || activePerception.jobId !== jobId || !activePerception.paused) return;
  await new Promise<void>((resolve) => {
    if (activePerception?.jobId === jobId) activePerception.resume = resolve;
    else resolve();
  });
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function proxyQuality(quality: ProxyRequest["quality"]) {
  if (quality === "low") return QUALITY_LOW;
  if (quality === "high") return QUALITY_HIGH;
  return QUALITY_MEDIUM;
}

async function proxyTracks(
  input: Input,
  request: ProxyRequest,
): Promise<{ track: VideoTrack | null; audioTrack: AudioTrack | null }> {
  const [track, audioTrack] = await Promise.all([
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
  ]);
  if (request.assetKind === "video" && !track) throw new Error("source-undecodable");
  if (request.assetKind === "audio" && !audioTrack) throw new Error("source-undecodable");
  if (track && !(await track.canDecode())) throw new Error("source-undecodable");
  if (audioTrack && !(await audioTrack.canDecode())) throw new Error("source-undecodable");
  return { track, audioTrack };
}

function proxySize(request: ProxyRequest): { width: number; height: number } {
  const scale = Math.min(1, request.maxLongEdge / Math.max(request.width, request.height));
  return { width: even(request.width * scale), height: even(request.height * scale) };
}

function proxyWritable(request: ProxyRequest): {
  writable: WritableStream<StreamTargetChunk>;
  bytes: () => number;
} {
  let maxEnd = 0;
  const writable = new WritableStream<StreamTargetChunk>({
    write: async (chunk) => {
      assertActive(request.jobId);
      const chunkId = nextChunkId++;
      const copy = chunk.data.slice().buffer;
      maxEnd = Math.max(maxEnd, chunk.position + copy.byteLength);
      await new Promise<void>((resolve, reject) => {
        chunkAcks.set(chunkId, { resolve, reject });
        post(
          {
            type: "proxy-chunk",
            jobId: request.jobId,
            chunkId,
            offset: chunk.position,
            data: copy,
          },
          [copy],
        );
      });
    },
  });
  return { writable, bytes: () => maxEnd };
}

async function createProxyConversion(
  input: Input,
  request: ProxyRequest,
  track: VideoTrack | null,
  audioTrack: AudioTrack | null,
  writable: WritableStream<StreamTargetChunk>,
): Promise<Conversion> {
  const quality = proxyQuality(request.quality);
  const { width, height } = proxySize(request);
  const [codec, audioCodec] = await Promise.all([
    track
      ? getFirstEncodableVideoCodec(["avc", "hevc"], { width, height, quality })
      : Promise.resolve(null),
    audioTrack ? getFirstEncodableAudioCodec(["aac"], { quality }) : Promise.resolve(null),
  ]);
  if (track && !codec) throw new Error("proxy-encoder-unavailable");
  if (audioTrack && !audioCodec) throw new Error("proxy-audio-encoder-unavailable");
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }),
  });
  return Conversion.init({
    input,
    output,
    tracks: "primary",
    video: track
      ? {
          width,
          height,
          fit: "contain",
          frameRate: Math.min(request.frameRateCap, Math.max(1, request.frameRate ?? 30)),
          codec: codec!,
          quality,
          keyFrameInterval: 0.75,
          hardwareAcceleration: "prefer-hardware",
          forceTranscode: true,
        }
      : { discard: true },
    audio: audioTrack ? { codec: audioCodec!, quality, forceTranscode: true } : { discard: true },
    tags: {},
    showWarnings: false,
  });
}

async function executeProxyConversion(
  request: ProxyRequest,
  conversion: Conversion,
): Promise<void> {
  while (conversion.state !== "done") {
    assertActive(request.jobId);
    await waitUntilResumed(request.jobId);
    assertActive(request.jobId);
    const pauseController = new AbortController();
    if (activeProxy?.jobId === request.jobId) activeProxy.pauseController = pauseController;
    try {
      await conversion.execute({ pauseSignal: pauseController.signal });
    } catch (error) {
      if (!activeProxy?.paused) throw error;
    }
  }
}

async function waitUntilResumed(jobId: string): Promise<void> {
  if (!activeProxy || activeProxy.jobId !== jobId || !activeProxy.paused) return;
  await new Promise<void>((resolve) => {
    if (activeProxy?.jobId === jobId) activeProxy.resume = resolve;
    else resolve();
  });
}

async function generateProxy(request: ProxyRequest) {
  const started = performance.now();
  activity(request.jobId, "input-opening", started);
  const input = mediaInput(request);
  activeProxy = {
    jobId: request.jobId,
    conversion: null,
    pauseController: null,
    paused: false,
    resume: null,
  };
  try {
    if (!(await input.canRead())) throw new Error("unsupported-container");
    activity(request.jobId, "container-ready", started);
    const { track, audioTrack } = await proxyTracks(input, request);
    activity(request.jobId, "track-ready", started);
    activity(request.jobId, "decoder-ready", started);
    const target = proxyWritable(request);
    const conversion = await createProxyConversion(
      input,
      request,
      track,
      audioTrack,
      target.writable,
    );
    if (!conversion.isValid) throw new Error("proxy-conversion-invalid");
    activity(request.jobId, "proxy-converting", started);
    activeProxy.conversion = conversion;
    conversion.onProgress = (value) =>
      post({ type: "proxy-progress", jobId: request.jobId, progress: value });
    await executeProxyConversion(request, conversion);
    activity(request.jobId, "completed", started);
    post({ type: "proxy-complete", jobId: request.jobId, bytes: target.bytes() });
  } finally {
    input.dispose();
    activeProxy = null;
    canceled.delete(request.jobId);
  }
}

async function waitUntilTranscriptResumed(jobId: string): Promise<void> {
  if (!activeTranscript || activeTranscript.jobId !== jobId || !activeTranscript.paused) return;
  await new Promise<void>((resolve) => {
    if (activeTranscript?.jobId === jobId) activeTranscript.resume = resolve;
    else resolve();
  });
}

async function transcriptAudioTrack(input: Input): Promise<AudioTrack> {
  if (!(await input.canRead())) throw new Error("unsupported-container");
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) throw new Error("source-has-no-audio");
  if (!(await audioTrack.canDecode())) throw new Error("source-audio-undecodable");
  return audioTrack;
}

async function createTranscriptConversion(
  input: Input,
  sourceStartUs: TimeUs,
  sourceEndUs: TimeUs,
  target: BufferTarget,
): Promise<Conversion> {
  return Conversion.init({
    input,
    output: new Output({ format: new WavOutputFormat(), target }),
    tracks: "primary",
    video: { discard: true },
    audio: {
      codec: "pcm-s16",
      numberOfChannels: 1,
      sampleRate: 16_000,
      sampleFormat: "s16",
      forceTranscode: true,
    },
    trim: { start: sourceStartUs / 1_000_000, end: sourceEndUs / 1_000_000 },
    tags: {},
    showWarnings: false,
  });
}

async function executeTranscriptConversion(
  request: TranscriptRequest,
  conversion: Conversion,
): Promise<void> {
  while (conversion.state !== "done") {
    assertActive(request.jobId);
    await waitUntilTranscriptResumed(request.jobId);
    const pauseController = new AbortController();
    if (activeTranscript?.jobId === request.jobId)
      activeTranscript.pauseController = pauseController;
    try {
      await conversion.execute({ pauseSignal: pauseController.signal });
    } catch (error) {
      if (!activeTranscript?.paused) throw error;
    }
  }
}

async function sendTranscriptChunk(
  request: TranscriptRequest,
  chunkIndex: number,
  sourceStartUs: TimeUs,
  sourceEndUs: TimeUs,
  data: ArrayBuffer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transcriptChunkAcks.set(chunkIndex, { resolve, reject });
    post(
      {
        type: "transcript-chunk",
        jobId: request.jobId,
        chunkIndex,
        sourceStartUs,
        sourceEndUs,
        data,
      },
      [data],
    );
  });
}

async function convertTranscriptChunk(
  input: Input,
  request: TranscriptRequest,
  chunkIndex: number,
  sourceStartUs: TimeUs,
): Promise<TimeUs> {
  const sourceEndUs = timeUs(Math.min(request.durationUs, sourceStartUs + request.chunkDurationUs));
  const target = new BufferTarget();
  const conversion = await createTranscriptConversion(input, sourceStartUs, sourceEndUs, target);
  if (!conversion.isValid) throw new Error("transcript-conversion-invalid");
  if (activeTranscript?.jobId === request.jobId) activeTranscript.conversion = conversion;
  conversion.onProgress = (value) => {
    const chunkProgress =
      (sourceStartUs + value * (sourceEndUs - sourceStartUs)) / request.durationUs;
    post({
      type: "transcript-progress",
      jobId: request.jobId,
      progress: Math.min(0.99, chunkProgress),
    });
  };
  await executeTranscriptConversion(request, conversion);
  const data = target.buffer;
  if (!data || data.byteLength === 0) throw new Error("transcript-audio-empty");
  await sendTranscriptChunk(request, chunkIndex, sourceStartUs, sourceEndUs, data);
  post({
    type: "transcript-progress",
    jobId: request.jobId,
    progress: sourceEndUs / request.durationUs,
  });
  return sourceEndUs;
}

async function generateTranscript(request: TranscriptRequest): Promise<void> {
  const input = mediaInput(request);
  activeTranscript = {
    jobId: request.jobId,
    conversion: null,
    pauseController: null,
    paused: false,
    resume: null,
  };
  try {
    await transcriptAudioTrack(input);
    let chunkIndex = 0;
    for (
      let sourceStartUs = timeUs(0);
      sourceStartUs < request.durationUs;
      sourceStartUs = timeUs(sourceStartUs + request.chunkDurationUs)
    ) {
      assertActive(request.jobId);
      await waitUntilTranscriptResumed(request.jobId);
      await convertTranscriptChunk(input, request, chunkIndex, sourceStartUs);
      chunkIndex += 1;
    }
    post({ type: "transcript-complete", jobId: request.jobId });
  } finally {
    input.dispose();
    if (activeTranscript?.jobId === request.jobId) {
      activeTranscript.resume?.();
      activeTranscript = null;
    }
    canceled.delete(request.jobId);
  }
}

function cancelJob(jobId: string): void {
  canceled.add(jobId);
  if (activePerception?.jobId === jobId) activePerception.resume?.();
  if (activeProxy?.jobId === jobId) {
    activeProxy.resume?.();
    void activeProxy.conversion?.cancel();
  }
  if (activeTranscript?.jobId === jobId) {
    activeTranscript.resume?.();
    void activeTranscript.conversion?.cancel();
  }
}

function settleAck(
  acknowledgements: Map<number, { resolve: () => void; reject: (error: Error) => void }>,
  id: number,
  error?: string,
): void {
  const ack = acknowledgements.get(id);
  if (!ack) return;
  acknowledgements.delete(id);
  if (error) ack.reject(new Error(error));
  else ack.resolve();
}

function pauseProxy(jobId: string): void {
  if (activeProxy?.jobId !== jobId) return;
  activeProxy.paused = true;
  activeProxy.pauseController?.abort();
}

function resumeProxy(jobId: string): void {
  if (activeProxy?.jobId !== jobId) return;
  activeProxy.paused = false;
  activeProxy.resume?.();
  activeProxy.resume = null;
}

function pausePerception(jobId: string): void {
  if (activePerception?.jobId === jobId) activePerception.paused = true;
}

function resumePerception(jobId: string): void {
  if (activePerception?.jobId !== jobId) return;
  activePerception.paused = false;
  activePerception.resume?.();
  activePerception.resume = null;
}

function pauseTranscript(jobId: string): void {
  if (activeTranscript?.jobId !== jobId) return;
  activeTranscript.paused = true;
  activeTranscript.pauseController?.abort();
}

function resumeTranscript(jobId: string): void {
  if (activeTranscript?.jobId !== jobId) return;
  activeTranscript.paused = false;
  activeTranscript.resume?.();
  activeTranscript.resume = null;
}

function handleWorkerControl(request: DerivedWorkerRequest): boolean {
  switch (request.type) {
    case "cancel":
      cancelJob(request.jobId);
      return true;
    case "proxy-chunk-ack":
      settleAck(chunkAcks, request.chunkId, request.error);
      return true;
    case "transcript-chunk-ack":
      settleAck(transcriptChunkAcks, request.chunkIndex, request.error);
      return true;
    case "proxy-pause":
      pauseProxy(request.jobId);
      return true;
    case "proxy-resume":
      resumeProxy(request.jobId);
      return true;
    case "perception-pause":
      pausePerception(request.jobId);
      return true;
    case "perception-resume":
      resumePerception(request.jobId);
      return true;
    case "transcript-pause":
      pauseTranscript(request.jobId);
      return true;
    case "transcript-resume":
      resumeTranscript(request.jobId);
      return true;
    default:
      return false;
  }
}

function generationFailure(jobId: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : "Derived media generation failed";
  let failureCode = "generation-failed";
  if (detail === "source-undecodable" || detail === "unsupported-container") failureCode = detail;
  else if (error instanceof DOMException && error.name === "AbortError") failureCode = "canceled";
  post({ type: "failed", jobId, failureCode, detail });
}

function startGeneration(
  request: GenerateRequest | ProxyRequest | TranscriptRequest | FrameRequest,
): void {
  let operation: Promise<void>;
  if (request.type === "proxy") operation = generateProxy(request);
  else if (request.type === "transcript") operation = generateTranscript(request);
  else if (request.type === "frame") operation = generateFrame(request);
  else operation = generate(request);
  void operation.catch((error: unknown) => generationFailure(request.jobId, error));
}

scope.onmessage = (event: MessageEvent<DerivedWorkerRequest>) => {
  const request = event.data;
  if (handleWorkerControl(request)) return;
  if (
    request.type === "proxy" ||
    request.type === "generate" ||
    request.type === "transcript" ||
    request.type === "frame"
  ) {
    startGeneration(request);
  }
};

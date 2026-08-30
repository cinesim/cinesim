/// <reference lib="webworker" />

import {
  filmstripSampleTimes,
  nearestSampleIndex,
  scoreThumbnailRgba,
  thumbnailCandidateTimes,
} from "@cinesim/engine";
import { timeUs } from "@cinesim/core";
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

async function generate(request: Extract<DerivedWorkerRequest, { type: "generate" }>) {
  const started = performance.now();
  activePerception = { jobId: request.jobId, paused: false, resume: null };
  activity(request.jobId, "input-opening", started);
  const input = new Input({
    source: new UrlSource(
      originalMediaUrl({ id: request.assetId as `asset_${string}` }, request.projectScope),
      {
        maxCacheSize: 32 * 1024 * 1024,
        parallelism: 1,
      },
    ),
    formats: ALL_FORMATS,
  });
  try {
    if (!(await input.canRead())) throw new Error("unsupported-container");
    activity(request.jobId, "container-ready", started);
    const needsVideo = request.kinds.some((kind) => kind !== "waveform");
    const needsAudio = request.kinds.includes("waveform");
    const [track, audioTrack] = await Promise.all([
      needsVideo ? input.getPrimaryVideoTrack() : null,
      needsAudio ? input.getPrimaryAudioTrack() : null,
    ]);
    if (needsVideo && !track) throw new Error("source-undecodable");
    if (needsAudio && !audioTrack) throw new Error("source-has-no-audio");
    activity(request.jobId, "track-ready", started);
    if (track && !(await track.canDecode())) throw new Error("source-undecodable");
    if (audioTrack && !(await audioTrack.canDecode())) throw new Error("source-audio-undecodable");
    activity(request.jobId, "decoder-ready", started);

    let sourceTimeUs = request.thumbnailSourceTimeUs ?? timeUs(0);
    if (request.kinds.includes("thumbnail")) {
      const candidateTimesUs = thumbnailCandidateTimes(request.durationUs);
      activity(request.jobId, "thumbnail-sampling", started, {
        completedSamples: 0,
        totalSamples: candidateTimesUs.length,
      });
      const candidateSink = new CanvasSink(track!, {
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
      sourceTimeUs = candidateTimesUs[0] ?? timeUs(0);
      let candidateIndex = 0;
      for await (const wrapped of candidateSink.canvasesAtTimestamps(
        candidateTimesUs.map((timeUs) => timeUs / 1_000_000),
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
        {
          type: "thumbnail-complete",
          jobId: request.jobId,
          thumbnail: thumbnailBytes,
          sourceTimeUs,
        },
        [thumbnailBytes],
      );
      activity(request.jobId, "thumbnail-ready", started, {
        completedSamples: candidateIndex,
        totalSamples: candidateTimesUs.length,
      });
    }

    if (request.kinds.includes("filmstrip")) {
      const tileTimesUs = filmstripSampleTimes(request.durationUs);
      if (tileTimesUs.length === 0) throw new Error("no-video-frames");
      activity(request.jobId, "filmstrip-sampling", started, {
        completedSamples: 0,
        totalSamples: tileTimesUs.length,
      });
      const nearest = nearestSampleIndex(tileTimesUs, sourceTimeUs);
      const spacing = request.durationUs / Math.max(1, tileTimesUs.length);
      if (Math.abs(tileTimesUs[nearest]! - sourceTimeUs) > spacing / 2) {
        tileTimesUs[nearest] = sourceTimeUs;
        tileTimesUs.sort((left, right) => left - right);
      }
      const rows = Math.ceil(tileTimesUs.length / COLUMNS);
      const contactSheet = new OffscreenCanvas(COLUMNS * TILE_WIDTH, rows * TILE_HEIGHT);
      const contactContext = contactSheet.getContext("2d");
      if (!contactContext) throw new Error("canvas-unavailable");
      const filmstripSink = new CanvasSink(track!, {
        width: TILE_WIDTH,
        height: TILE_HEIGHT,
        fit: "contain",
        poolSize: 2,
        decoderOptions: { hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
      });
      let tileIndex = 0;
      for await (const wrapped of filmstripSink.canvasesAtTimestamps(
        tileTimesUs.map((timeUs) => timeUs / 1_000_000),
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

    if (request.kinds.includes("waveform")) {
      await generateWaveform(request, audioTrack!, started);
    }
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

async function waitUntilResumed(jobId: string): Promise<void> {
  if (!activeProxy || activeProxy.jobId !== jobId || !activeProxy.paused) return;
  await new Promise<void>((resolve) => {
    if (activeProxy?.jobId === jobId) activeProxy.resume = resolve;
    else resolve();
  });
}

async function generateProxy(request: Extract<DerivedWorkerRequest, { type: "proxy" }>) {
  const started = performance.now();
  activity(request.jobId, "input-opening", started);
  const input = new Input({
    source: new UrlSource(
      originalMediaUrl({ id: request.assetId as `asset_${string}` }, request.projectScope),
      {
        maxCacheSize: 32 * 1024 * 1024,
        parallelism: 1,
      },
    ),
    formats: ALL_FORMATS,
  });
  let maxEnd = 0;
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
    const [track, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    if (request.assetKind === "video" && !track) throw new Error("source-undecodable");
    if (request.assetKind === "audio" && !audioTrack) throw new Error("source-undecodable");
    activity(request.jobId, "track-ready", started);
    if (track && !(await track.canDecode())) throw new Error("source-undecodable");
    if (audioTrack && !(await audioTrack.canDecode())) throw new Error("source-undecodable");
    activity(request.jobId, "decoder-ready", started);
    const quality =
      request.quality === "low"
        ? QUALITY_LOW
        : request.quality === "high"
          ? QUALITY_HIGH
          : QUALITY_MEDIUM;
    const scale = Math.min(1, request.maxLongEdge / Math.max(request.width, request.height));
    const width = even(request.width * scale);
    const height = even(request.height * scale);
    const [codec, audioCodec] = await Promise.all([
      track
        ? getFirstEncodableVideoCodec(["avc", "hevc"], { width, height, quality })
        : Promise.resolve(null),
      audioTrack ? getFirstEncodableAudioCodec(["aac"], { quality }) : Promise.resolve(null),
    ]);
    if (track && !codec) throw new Error("proxy-encoder-unavailable");
    if (audioTrack && !audioCodec) throw new Error("proxy-audio-encoder-unavailable");
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
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }),
    });
    const conversion = await Conversion.init({
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
    if (!conversion.isValid) throw new Error("proxy-conversion-invalid");
    activity(request.jobId, "proxy-converting", started);
    activeProxy.conversion = conversion;
    conversion.onProgress = (value) =>
      post({ type: "proxy-progress", jobId: request.jobId, progress: value });
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
    activity(request.jobId, "completed", started);
    post({ type: "proxy-complete", jobId: request.jobId, bytes: maxEnd });
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

async function generateTranscript(
  request: Extract<DerivedWorkerRequest, { type: "transcript" }>,
): Promise<void> {
  const input = new Input({
    source: new UrlSource(
      originalMediaUrl({ id: request.assetId as `asset_${string}` }, request.projectScope),
      { maxCacheSize: 32 * 1024 * 1024, parallelism: 1 },
    ),
    formats: ALL_FORMATS,
  });
  activeTranscript = {
    jobId: request.jobId,
    conversion: null,
    pauseController: null,
    paused: false,
    resume: null,
  };
  try {
    if (!(await input.canRead())) throw new Error("unsupported-container");
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) throw new Error("source-has-no-audio");
    if (!(await audioTrack.canDecode())) throw new Error("source-audio-undecodable");
    let chunkIndex = 0;
    for (
      let sourceStartUs = timeUs(0);
      sourceStartUs < request.durationUs;
      sourceStartUs = timeUs(sourceStartUs + request.chunkDurationUs)
    ) {
      assertActive(request.jobId);
      await waitUntilTranscriptResumed(request.jobId);
      const sourceEndUs = timeUs(
        Math.min(request.durationUs, sourceStartUs + request.chunkDurationUs),
      );
      const target = new BufferTarget();
      const output = new Output({ format: new WavOutputFormat(), target });
      const conversion = await Conversion.init({
        input,
        output,
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
      const data = target.buffer;
      if (!data || data.byteLength === 0) throw new Error("transcript-audio-empty");
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
      chunkIndex += 1;
      post({
        type: "transcript-progress",
        jobId: request.jobId,
        progress: sourceEndUs / request.durationUs,
      });
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

scope.onmessage = (event: MessageEvent<DerivedWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    canceled.add(request.jobId);
    if (activePerception?.jobId === request.jobId) activePerception.resume?.();
    if (activeProxy?.jobId === request.jobId) {
      activeProxy.resume?.();
      void activeProxy.conversion?.cancel();
    }
    if (activeTranscript?.jobId === request.jobId) {
      activeTranscript.resume?.();
      void activeTranscript.conversion?.cancel();
    }
    return;
  }
  if (request.type === "proxy-chunk-ack") {
    const ack = chunkAcks.get(request.chunkId);
    if (!ack) return;
    chunkAcks.delete(request.chunkId);
    if (request.error) ack.reject(new Error(request.error));
    else ack.resolve();
    return;
  }
  if (request.type === "transcript-chunk-ack") {
    const ack = transcriptChunkAcks.get(request.chunkIndex);
    if (!ack) return;
    transcriptChunkAcks.delete(request.chunkIndex);
    if (request.error) ack.reject(new Error(request.error));
    else ack.resolve();
    return;
  }
  if (request.type === "proxy-pause") {
    if (activeProxy?.jobId === request.jobId) {
      activeProxy.paused = true;
      activeProxy.pauseController?.abort();
    }
    return;
  }
  if (request.type === "proxy-resume") {
    if (activeProxy?.jobId === request.jobId) {
      activeProxy.paused = false;
      activeProxy.resume?.();
      activeProxy.resume = null;
    }
    return;
  }
  if (request.type === "perception-pause") {
    if (activePerception?.jobId === request.jobId) activePerception.paused = true;
    return;
  }
  if (request.type === "perception-resume") {
    if (activePerception?.jobId === request.jobId) {
      activePerception.paused = false;
      activePerception.resume?.();
      activePerception.resume = null;
    }
    return;
  }
  if (request.type === "transcript-pause") {
    if (activeTranscript?.jobId === request.jobId) {
      activeTranscript.paused = true;
      activeTranscript.pauseController?.abort();
    }
    return;
  }
  if (request.type === "transcript-resume") {
    if (activeTranscript?.jobId === request.jobId) {
      activeTranscript.paused = false;
      activeTranscript.resume?.();
      activeTranscript.resume = null;
    }
    return;
  }
  if (request.type !== "proxy" && request.type !== "generate" && request.type !== "transcript")
    return;
  const operation =
    request.type === "proxy"
      ? generateProxy(request)
      : request.type === "transcript"
        ? generateTranscript(request)
        : generate(request);
  void operation.catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : "Derived media generation failed";
    const failureCode =
      detail === "source-undecodable" || detail === "unsupported-container"
        ? detail
        : error instanceof DOMException && error.name === "AbortError"
          ? "canceled"
          : "generation-failed";
    post({ type: "failed", jobId: request.jobId, failureCode, detail });
  });
};

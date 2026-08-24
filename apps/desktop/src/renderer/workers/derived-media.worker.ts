/// <reference lib="webworker" />

import {
  filmstripSampleTimes,
  nearestSampleIndex,
  scoreThumbnailRgba,
  thumbnailCandidateTimes,
} from "@cinesim/engine";
import {
  ALL_FORMATS,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  StreamTarget,
  UrlSource,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import type { StreamTargetChunk } from "mediabunny";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "../media/derived-worker-api";
import { originalMediaUrl } from "../media/media-url";

const scope = self as DedicatedWorkerGlobalScope;
const canceled = new Set<string>();
const chunkAcks = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
let activeProxy: {
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

function progress(jobId: string, stage: "thumbnail" | "filmstrip", value: number): void {
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
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("source-undecodable");
    activity(request.jobId, "track-ready", started);
    if (!(await track.canDecode())) throw new Error("source-undecodable");
    activity(request.jobId, "decoder-ready", started);

    let sourceTimeUs = request.thumbnailSourceTimeUs ?? 0;
    if (request.kinds.includes("thumbnail")) {
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
      sourceTimeUs = candidateTimesUs[0] ?? 0;
      let candidateIndex = 0;
      for await (const wrapped of candidateSink.canvasesAtTimestamps(
        candidateTimesUs.map((timeUs) => timeUs / 1_000_000),
        { verifyKeyPackets: false },
      )) {
        assertActive(request.jobId);
        const requestedTimeUs = candidateTimesUs[candidateIndex] ?? 0;
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

    if (!request.kinds.includes("filmstrip")) {
      activity(request.jobId, "completed", started);
      post({
        type: "perception-complete",
        jobId: request.jobId,
        samplingLatencyMs: performance.now() - started,
      });
      return;
    }

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
    const filmstripSink = new CanvasSink(track, {
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
    activity(request.jobId, "completed", started);
    post({
      type: "perception-complete",
      jobId: request.jobId,
      samplingLatencyMs: performance.now() - started,
    });
  } finally {
    input.dispose();
    canceled.delete(request.jobId);
  }
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
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("source-undecodable");
    activity(request.jobId, "track-ready", started);
    if (!(await track.canDecode())) throw new Error("source-undecodable");
    activity(request.jobId, "decoder-ready", started);
    const scale = Math.min(1, 1280 / Math.max(request.width, request.height));
    const width = even(request.width * scale);
    const height = even(request.height * scale);
    const codec = await getFirstEncodableVideoCodec(["avc", "hevc"], {
      width,
      height,
      quality: QUALITY_MEDIUM,
    });
    if (!codec) throw new Error("proxy-encoder-unavailable");
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
      video: {
        width,
        height,
        fit: "contain",
        frameRate: Math.min(60, Math.max(1, request.frameRate ?? 30)),
        codec,
        quality: QUALITY_MEDIUM,
        keyFrameInterval: 0.75,
        hardwareAcceleration: "prefer-hardware",
        forceTranscode: true,
      },
      audio: { discard: true },
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

scope.onmessage = (event: MessageEvent<DerivedWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    canceled.add(request.jobId);
    if (activeProxy?.jobId === request.jobId) {
      activeProxy.resume?.();
      void activeProxy.conversion?.cancel();
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
  if (request.type !== "proxy" && request.type !== "generate") return;
  const operation = request.type === "proxy" ? generateProxy(request) : generate(request);
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

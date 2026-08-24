/// <reference lib="webworker" />

import {
  filmstripSampleTimes,
  nearestSampleIndex,
  scoreThumbnailRgba,
  thumbnailCandidateTimes,
} from "@cinesim/engine";
import { ALL_FORMATS, CanvasSink, Input, UrlSource } from "mediabunny";
import type { DerivedWorkerRequest, DerivedWorkerResponse } from "../media/derived-worker-api";

const scope = self as DedicatedWorkerGlobalScope;
const canceled = new Set<string>();
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

function assertActive(jobId: string): void {
  if (canceled.has(jobId)) throw new DOMException("Derived job canceled", "AbortError");
}

async function generate(request: Extract<DerivedWorkerRequest, { type: "generate" }>) {
  const started = performance.now();
  const input = new Input({
    source: new UrlSource(`cinesim-media://asset/${request.assetId}`, {
      maxCacheSize: 32 * 1024 * 1024,
      parallelism: 1,
    }),
    formats: ALL_FORMATS,
  });
  try {
    if (!(await input.canRead())) throw new Error("unsupported-container");
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error("source-undecodable");

    const candidateTimesUs = thumbnailCandidateTimes(request.durationUs);
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
    let sourceTimeUs = candidateTimesUs[0] ?? 0;
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

    const tileTimesUs = filmstripSampleTimes(request.durationUs);
    if (tileTimesUs.length === 0) throw new Error("no-video-frames");
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
    const [thumbnailBlob, filmstripBlob] = await Promise.all([
      thumbnail.convertToBlob({ type: "image/jpeg", quality: 0.84 }),
      contactSheet.convertToBlob({ type: "image/jpeg", quality: 0.78 }),
    ]);
    const [thumbnailBytes, filmstripBytes] = await Promise.all([
      thumbnailBlob.arrayBuffer(),
      filmstripBlob.arrayBuffer(),
    ]);
    post(
      {
        type: "complete",
        jobId: request.jobId,
        thumbnail: thumbnailBytes,
        filmstrip: filmstripBytes,
        sourceTimeUs,
        tileTimesUs,
        columns: COLUMNS,
        rows,
        tileWidth: TILE_WIDTH,
        tileHeight: TILE_HEIGHT,
        samplingLatencyMs: performance.now() - started,
      },
      [thumbnailBytes, filmstripBytes],
    );
  } finally {
    input.dispose();
    canceled.delete(request.jobId);
  }
}

scope.onmessage = (event: MessageEvent<DerivedWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    canceled.add(request.jobId);
    return;
  }
  void generate(request).catch((error: unknown) => {
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

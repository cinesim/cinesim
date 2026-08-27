import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { protocol } from "electron";
import type { DerivedArtifactKind, DerivedProjectScope } from "../../shared/api";
import type { DesktopProjectStore } from "../projects/project-store";
import type { CloudMediaManager } from "../cloud/manager";
import { parseDerivedProjectScope } from "./ipc-validation";
import { DERIVED_GENERATOR_VERSION } from "./service";

function streamedMediaResponse(
  store: DesktopProjectStore,
  input: {
    path: string;
    size: number;
    mimeType: string;
    assetId: string;
    start: number;
    endExclusive: number;
    range: boolean;
    cacheControl: string;
    requestStarted: number;
  },
): Response {
  const start = Math.max(0, Math.min(input.start, input.size));
  const endExclusive = Math.max(start, Math.min(input.endExclusive, input.size));
  const length = endExclusive - start;
  const headers = {
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": String(length),
    ...(input.range
      ? { "Content-Range": `bytes ${start}-${Math.max(start, endExclusive - 1)}/${input.size}` }
      : {}),
    "Content-Type": input.mimeType,
    "Cache-Control": input.cacheControl,
  };
  if (length === 0) {
    store.derivedMedia.recordProtocolRead({
      assetId: input.assetId,
      start,
      requestedEnd: endExclusive,
      bytesRead: 0,
      durationMs: performance.now() - input.requestStarted,
      range: input.range,
    });
    return new Response(null, { status: input.range ? 206 : 200, headers });
  }
  const stream = createReadStream(input.path, {
    start,
    end: endExclusive - 1,
    highWaterMark: 64 * 1024,
  });
  let settled = false;
  const recordRead = () => {
    if (settled) return;
    settled = true;
    store.derivedMedia.recordProtocolRead({
      assetId: input.assetId,
      start,
      requestedEnd: endExclusive,
      bytesRead: stream.bytesRead,
      durationMs: performance.now() - input.requestStarted,
      range: input.range,
    });
  };
  stream.once("error", (error) => {
    if (error.name === "AbortError") {
      recordRead();
      return;
    }
    settled = true;
    store.derivedMedia.recordProtocolError(
      input.assetId,
      error.message,
      performance.now() - input.requestStarted,
    );
  });
  stream.once("close", recordRead);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: input.range ? 206 : 200,
    headers,
  });
}

export async function registerMediaProtocol(
  store: DesktopProjectStore,
  cloudMedia: CloudMediaManager,
): Promise<void> {
  protocol.handle("cinesim-media", async (request) => {
    const requestStarted = performance.now();
    let diagnosticAssetId: string | undefined;
    try {
      const url = new URL(request.url);
      const derivedKind = (
        {
          thumbnail: "thumbnail",
          filmstrip: "filmstrip",
          waveform: "waveform",
          proxy: "proxy",
        } as const
      )[url.hostname as "thumbnail" | "filmstrip" | "waveform" | "proxy"];
      if (url.hostname !== "asset" && !derivedKind)
        return new Response("Not found", { status: 404 });
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length !== 2) return new Response("Bad media path", { status: 400 });
      const [cacheKey, assetId] = pathParts as [string, string];
      if (!/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(assetId))
        return new Response("Bad asset ID", { status: 400 });
      let projectScope: DerivedProjectScope;
      try {
        projectScope = parseDerivedProjectScope({
          cacheKey,
          epoch: url.searchParams.get("epoch"),
        });
      } catch {
        return new Response("Bad project scope", { status: 400 });
      }
      try {
        store.derivedMedia.assertScope(projectScope);
      } catch {
        return new Response("Stale project scope", { status: 409 });
      }
      diagnosticAssetId = assetId;
      const range = request.headers.get("range");
      if (derivedKind) {
        if (url.searchParams.get("v") !== DERIVED_GENERATOR_VERSION)
          return new Response("Unknown generator version", { status: 404 });
        const profileId = url.searchParams.get("profile") ?? undefined;
        const revision = url.searchParams.get("revision") ?? undefined;
        if (
          (derivedKind === "proxy" && !profileId) ||
          (profileId !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileId))
        )
          return new Response("Bad proxy profile", { status: 400 });
        const result = await store.derivedMedia.artifactFile(
          projectScope,
          derivedKind as DerivedArtifactKind,
          assetId,
          profileId,
          revision,
        );
        if (request.method === "HEAD")
          return new Response(null, {
            status: 200,
            headers: {
              "Accept-Ranges": "bytes",
              "Access-Control-Allow-Origin": "*",
              "Content-Length": String(result.size),
              "Content-Type": result.mimeType,
              "Cache-Control": "private, max-age=31536000, immutable",
            },
          });
        const match = range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = match ? Number(match[1]) : 0;
        const requestedEnd = match?.[2] ? Number(match[2]) + 1 : result.size;
        return streamedMediaResponse(store, {
          path: result.path,
          size: result.size,
          mimeType: result.mimeType,
          assetId,
          start,
          endExclusive: requestedEnd,
          range: Boolean(range),
          cacheControl: "private, max-age=31536000, immutable",
          requestStarted,
        });
      }
      const asset = store.project?.assets.find((candidate) => candidate.id === assetId);
      if (!asset) return new Response("Unknown asset", { status: 404 });
      if (asset.source.kind === "cloud")
        return cloudMedia.readOriginal(asset.source.cloudAssetId, request);
      const path = asset.source.path;
      const size = (await stat(path)).size;
      if (request.method === "HEAD") {
        store.derivedMedia.recordProtocolRead({
          assetId,
          start: 0,
          requestedEnd: 0,
          bytesRead: 0,
          durationMs: performance.now() - requestStarted,
          range: false,
        });
        return new Response(null, {
          status: 200,
          headers: {
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Content-Length": String(size),
            "Content-Type": "application/octet-stream",
          },
        });
      }
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = match ? Number(match[1]) : 0;
      const requestedEnd = match?.[2] ? Number(match[2]) + 1 : size;
      return streamedMediaResponse(store, {
        path,
        size,
        mimeType: "application/octet-stream",
        assetId,
        start,
        endExclusive: requestedEnd,
        range: Boolean(range),
        cacheControl: "no-store",
        requestStarted,
      });
    } catch (error) {
      store.derivedMedia.recordProtocolError(
        diagnosticAssetId,
        error instanceof Error ? error.message : "Media read failed",
        performance.now() - requestStarted,
      );
      return new Response(error instanceof Error ? error.message : "Media read failed", {
        status: 500,
      });
    }
  });
}

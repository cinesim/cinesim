import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { DerivedArtifactKind, DerivedProjectScope } from "../../shared/contracts";
import type { CloudMediaManager } from "../cloud/manager";
import { parseSingleByteRange, unsatisfiedRangeResponse } from "../app/http-range";
import { CINESIM_MEDIA_SCHEME, CINESIM_RENDERER_ORIGIN, editorSession } from "../app/protocols";
import type { DesktopProjectStore } from "../projects/project-store";
import { parseDerivedProjectScope } from "./ipc-validation";
import { DERIVED_GENERATOR_VERSION } from "./service";

interface MediaBounds {
  kind: "full" | "range";
  start: number;
  endExclusive: number;
}

export function trustedMediaRequestOrigin(
  request: Pick<Request, "headers" | "referrer">,
  developmentUrl?: URL | null,
): string | null {
  const allowed = new Set([
    CINESIM_RENDERER_ORIGIN,
    ...(developmentUrl ? [developmentUrl.origin] : []),
  ]);
  const origin = request.headers.get("origin");
  if (origin) return allowed.has(origin) ? origin : null;
  try {
    const referrerOrigin = new URL(request.referrer).origin;
    return allowed.has(referrerOrigin) ? referrerOrigin : null;
  } catch {
    return null;
  }
}

function responseHeaders(input: {
  size: number;
  bounds: MediaBounds;
  mimeType: string;
  cacheControl: string;
  accessControlOrigin: string;
}): Record<string, string> {
  const length = input.bounds.endExclusive - input.bounds.start;
  return {
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": input.accessControlOrigin,
    "Content-Length": String(length),
    ...(input.bounds.kind === "range"
      ? {
          "Content-Range": `bytes ${input.bounds.start}-${input.bounds.endExclusive - 1}/${input.size}`,
        }
      : {}),
    "Content-Type": input.mimeType,
    "Cache-Control": input.cacheControl,
  };
}

function requestBounds(
  request: Request,
  size: number,
  accessControlOrigin: string,
): MediaBounds | Response {
  const parsed = parseSingleByteRange(request.headers.get("range"), size);
  return parsed.kind === "invalid" ? unsatisfiedRangeResponse(size, accessControlOrigin) : parsed;
}

function streamedMediaResponse(
  store: DesktopProjectStore,
  input: {
    path: string;
    size: number;
    mimeType: string;
    assetId: string;
    bounds: MediaBounds;
    cacheControl: string;
    requestStarted: number;
    accessControlOrigin: string;
  },
): Response {
  const length = input.bounds.endExclusive - input.bounds.start;
  const headers = responseHeaders(input);
  if (length === 0) {
    store.derivedMedia.recordProtocolRead({
      assetId: input.assetId,
      start: input.bounds.start,
      requestedEnd: input.bounds.endExclusive,
      bytesRead: 0,
      durationMs: performance.now() - input.requestStarted,
      range: input.bounds.kind === "range",
    });
    return new Response(null, { status: input.bounds.kind === "range" ? 206 : 200, headers });
  }
  const stream = createReadStream(input.path, {
    start: input.bounds.start,
    end: input.bounds.endExclusive - 1,
    highWaterMark: 64 * 1024,
  });
  let settled = false;
  const recordRead = () => {
    if (settled) return;
    settled = true;
    store.derivedMedia.recordProtocolRead({
      assetId: input.assetId,
      start: input.bounds.start,
      requestedEnd: input.bounds.endExclusive,
      bytesRead: stream.bytesRead,
      durationMs: performance.now() - input.requestStarted,
      range: input.bounds.kind === "range",
    });
  };
  stream.once("error", (error) => {
    if (error.name === "AbortError") return recordRead();
    settled = true;
    store.derivedMedia.recordProtocolError(
      input.assetId,
      error.message,
      performance.now() - input.requestStarted,
    );
  });
  stream.once("close", recordRead);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: input.bounds.kind === "range" ? 206 : 200,
    headers,
  });
}

function fileResponse(
  store: DesktopProjectStore,
  request: Request,
  input: {
    path: string;
    size: number;
    mimeType: string;
    assetId: string;
    cacheControl: string;
    requestStarted: number;
    accessControlOrigin: string;
  },
): Response {
  const bounds = requestBounds(request, input.size, input.accessControlOrigin);
  if (bounds instanceof Response) return bounds;
  if (request.method === "HEAD")
    return new Response(null, {
      status: bounds.kind === "range" ? 206 : 200,
      headers: responseHeaders({ ...input, bounds }),
    });
  return streamedMediaResponse(store, { ...input, bounds });
}

export async function registerMediaProtocol(
  store: DesktopProjectStore,
  cloudMedia: CloudMediaManager,
  developmentUrl?: URL | null,
): Promise<void> {
  editorSession().protocol.handle(CINESIM_MEDIA_SCHEME, async (request) => {
    const requestStarted = performance.now();
    let diagnosticAssetId: string | undefined;
    try {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      const accessControlOrigin = trustedMediaRequestOrigin(request, developmentUrl);
      if (!accessControlOrigin) return new Response("Forbidden", { status: 403 });
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
      if (!/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(assetId))
        return new Response("Bad asset ID", { status: 400 });
      let projectScope: DerivedProjectScope;
      try {
        projectScope = parseDerivedProjectScope({ cacheKey, epoch: url.searchParams.get("epoch") });
      } catch {
        return new Response("Bad project scope", { status: 400 });
      }
      try {
        store.derivedMedia.assertScope(projectScope);
      } catch {
        return new Response("Stale project scope", { status: 409 });
      }
      diagnosticAssetId = assetId;
      if (derivedKind) {
        if (url.searchParams.get("v") !== DERIVED_GENERATOR_VERSION)
          return new Response("Unknown generator version", { status: 404 });
        const profileId = url.searchParams.get("profile") ?? undefined;
        const revision = url.searchParams.get("revision") ?? undefined;
        if (
          (derivedKind === "proxy" && !profileId) ||
          (profileId !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(profileId))
        )
          return new Response("Bad proxy profile", { status: 400 });
        const result = await store.derivedMedia.artifactFile(
          projectScope,
          derivedKind as DerivedArtifactKind,
          assetId,
          profileId,
          revision,
        );
        return fileResponse(store, request, {
          path: result.path,
          size: result.size,
          mimeType: result.mimeType,
          assetId,
          cacheControl: "private, max-age=31536000, immutable",
          requestStarted,
          accessControlOrigin,
        });
      }
      const asset = store.project?.assets.find((candidate) => candidate.id === assetId);
      if (!asset) return new Response("Unknown asset", { status: 404 });
      if (asset.source.kind === "cloud") {
        const downloadedPath = await cloudMedia.downloadedOriginalPath(asset.id);
        if (!downloadedPath)
          return cloudMedia.readOriginal(asset.source.cloudAssetId, request, accessControlOrigin);
        return fileResponse(store, request, {
          path: downloadedPath,
          size: (await stat(downloadedPath)).size,
          mimeType: "application/octet-stream",
          assetId,
          cacheControl: "no-store",
          requestStarted,
          accessControlOrigin,
        });
      }
      return fileResponse(store, request, {
        path: asset.source.path,
        size: (await stat(asset.source.path)).size,
        mimeType: "application/octet-stream",
        assetId,
        cacheControl: "no-store",
        requestStarted,
        accessControlOrigin,
      });
    } catch (error) {
      store.derivedMedia.recordProtocolError(
        diagnosticAssetId,
        error instanceof Error ? error.message : "Media read failed",
        performance.now() - requestStarted,
      );
      return new Response("MEDIA_READ_FAILED", { status: 500 });
    }
  });
}

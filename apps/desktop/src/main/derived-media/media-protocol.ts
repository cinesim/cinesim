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

interface MediaRequestTarget {
  assetId: string;
  accessControlOrigin: string;
  projectScope: DerivedProjectScope;
  derivedKind: DerivedArtifactKind | null;
  url: URL;
}

const derivedKinds: Record<string, DerivedArtifactKind | undefined> = {
  thumbnail: "thumbnail",
  filmstrip: "filmstrip",
  waveform: "waveform",
  proxy: "proxy",
};

const assetIdPattern = /^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;
const profileIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

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

class MediaRequestHandler {
  constructor(
    private readonly store: DesktopProjectStore,
    private readonly cloudMedia: CloudMediaManager,
    private readonly developmentUrl?: URL | null,
  ) {}

  async handle(request: Request): Promise<Response> {
    const requestStarted = performance.now();
    let diagnosticAssetId: string | undefined;
    try {
      const target = this.#target(request);
      if (target instanceof Response) return target;
      diagnosticAssetId = target.assetId;
      return target.derivedKind
        ? await this.#derivedResponse(request, target, target.derivedKind, requestStarted)
        : await this.#assetResponse(request, target, requestStarted);
    } catch (error) {
      this.store.derivedMedia.recordProtocolError(
        diagnosticAssetId,
        error instanceof Error ? error.message : "Media read failed",
        performance.now() - requestStarted,
      );
      return new Response("MEDIA_READ_FAILED", { status: 500 });
    }
  }

  #target(request: Request): MediaRequestTarget | Response {
    const access = this.#access(request);
    if (access instanceof Response) return access;

    const url = new URL(request.url);
    const derivedKind = derivedKinds[url.hostname] ?? null;
    if (url.hostname !== "asset" && !derivedKind) return new Response("Not found", { status: 404 });

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 2) return new Response("Bad media path", { status: 400 });
    const [cacheKey, assetId] = pathParts as [string, string];
    if (!assetIdPattern.test(assetId)) return new Response("Bad asset ID", { status: 400 });

    const projectScope = this.#projectScope(cacheKey, url);
    if (projectScope instanceof Response) return projectScope;
    return { assetId, accessControlOrigin: access, projectScope, derivedKind, url };
  }

  #access(request: Request): string | Response {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }
    return (
      trustedMediaRequestOrigin(request, this.developmentUrl) ??
      new Response("Forbidden", { status: 403 })
    );
  }

  #projectScope(cacheKey: string, url: URL): DerivedProjectScope | Response {
    let projectScope: DerivedProjectScope;
    try {
      projectScope = parseDerivedProjectScope({ cacheKey, epoch: url.searchParams.get("epoch") });
    } catch {
      return new Response("Bad project scope", { status: 400 });
    }
    try {
      this.store.derivedMedia.assertScope(projectScope);
      return projectScope;
    } catch {
      return new Response("Stale project scope", { status: 409 });
    }
  }

  async #derivedResponse(
    request: Request,
    target: MediaRequestTarget,
    kind: DerivedArtifactKind,
    requestStarted: number,
  ): Promise<Response> {
    if (target.url.searchParams.get("v") !== DERIVED_GENERATOR_VERSION) {
      return new Response("Unknown generator version", { status: 404 });
    }
    const profileId = target.url.searchParams.get("profile") ?? undefined;
    const revision = target.url.searchParams.get("revision") ?? undefined;
    if (!this.#validProfile(kind, profileId)) {
      return new Response("Bad proxy profile", { status: 400 });
    }
    const result = await this.store.derivedMedia.artifactFile(
      target.projectScope,
      kind,
      target.assetId,
      profileId,
      revision,
    );
    return fileResponse(this.store, request, {
      path: result.path,
      size: result.size,
      mimeType: result.mimeType,
      assetId: target.assetId,
      cacheControl: "private, max-age=31536000, immutable",
      requestStarted,
      accessControlOrigin: target.accessControlOrigin,
    });
  }

  #validProfile(kind: DerivedArtifactKind | null, profileId: string | undefined): boolean {
    if (kind === "proxy" && !profileId) return false;
    return profileId === undefined || profileIdPattern.test(profileId);
  }

  async #assetResponse(
    request: Request,
    target: MediaRequestTarget,
    requestStarted: number,
  ): Promise<Response> {
    const asset = this.store.project?.assets.find((candidate) => candidate.id === target.assetId);
    if (!asset) return new Response("Unknown asset", { status: 404 });

    if (asset.source.kind === "cloud") {
      const downloadedPath = await this.cloudMedia.downloadedOriginalPath(asset.id);
      if (!downloadedPath) {
        return this.cloudMedia.readOriginal(
          asset.source.cloudAssetId,
          request,
          target.accessControlOrigin,
        );
      }
      return this.#localFileResponse(request, target, requestStarted, downloadedPath);
    }
    return this.#localFileResponse(request, target, requestStarted, asset.source.path);
  }

  async #localFileResponse(
    request: Request,
    target: MediaRequestTarget,
    requestStarted: number,
    path: string,
  ): Promise<Response> {
    return fileResponse(this.store, request, {
      path,
      size: (await stat(path)).size,
      mimeType: "application/octet-stream",
      assetId: target.assetId,
      cacheControl: "no-store",
      requestStarted,
      accessControlOrigin: target.accessControlOrigin,
    });
  }
}

export async function registerMediaProtocol(
  store: DesktopProjectStore,
  cloudMedia: CloudMediaManager,
  developmentUrl?: URL | null,
): Promise<void> {
  const handler = new MediaRequestHandler(store, cloudMedia, developmentUrl);
  editorSession().protocol.handle(CINESIM_MEDIA_SCHEME, (request) => handler.handle(request));
}

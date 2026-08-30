import type { ParsedByteRange } from "../app/http-range";
import { parseSingleByteRange, unsatisfiedRangeResponse } from "../app/http-range";
import type { CloudStorageGateway } from "./gateway";
import { SIGNED_URL_REFRESH_MARGIN_MS } from "./limits";

export interface SignedCloudOriginal {
  url: string;
  bytes: number;
  expiresAt: number;
}

function methodNotAllowedResponse(): Response {
  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: "GET, HEAD" },
  });
}

function responseStatus(bounds: ParsedByteRange): 200 | 206 {
  return bounds.kind === "range" ? 206 : 200;
}

function responseHeaders(
  bounds: Exclude<ParsedByteRange, { kind: "invalid" }>,
  bytes: number,
  accessControlOrigin: string,
): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": accessControlOrigin,
    "Content-Length": String(bounds.endExclusive - bounds.start),
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
  });
  if (bounds.kind === "range") {
    headers.set("Content-Range", `bytes ${bounds.start}-${bounds.endExclusive - 1}/${bytes}`);
  }
  return headers;
}

function requestHeaders(bounds: Exclude<ParsedByteRange, { kind: "invalid" }>): Headers {
  const headers = new Headers();
  if (bounds.kind === "range") {
    headers.set("range", `bytes=${bounds.start}-${bounds.endExclusive - 1}`);
  }
  return headers;
}

function copySafeUpstreamHeaders(source: Headers, destination: Headers): void {
  for (const name of ["etag", "last-modified"] as const) {
    const value = source.get(name);
    if (value) destination.set(name, value.slice(0, 1_024));
  }

  const contentType = source.get("content-type");
  if (contentType?.startsWith("video/") || contentType?.startsWith("audio/")) {
    destination.set("Content-Type", contentType.slice(0, 256));
  }
}

export class CloudOriginalReader {
  readonly #downloadUrls = new Map<string, SignedCloudOriginal>();

  constructor(private readonly gateway: CloudStorageGateway) {}

  async read(
    cloudAssetId: string,
    request: Request,
    accessControlOrigin: string,
  ): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowedResponse();

    const signed = await this.signedDownload(cloudAssetId);
    const bounds = parseSingleByteRange(request.headers.get("range"), signed.bytes);
    if (bounds.kind === "invalid") {
      return unsatisfiedRangeResponse(signed.bytes, accessControlOrigin);
    }

    const headers = responseHeaders(bounds, signed.bytes, accessControlOrigin);
    const status = responseStatus(bounds);
    if (request.method === "HEAD") return new Response(null, { status, headers });

    const response = await fetch(signed.url, {
      headers: requestHeaders(bounds),
      signal: request.signal,
    });
    this.#validateResponse(cloudAssetId, response, status);
    copySafeUpstreamHeaders(response.headers, headers);
    return new Response(response.body, { status, headers });
  }

  async signedDownload(cloudAssetId: string): Promise<SignedCloudOriginal> {
    let signed = this.#downloadUrls.get(cloudAssetId);
    if (!signed || signed.expiresAt <= Date.now() + SIGNED_URL_REFRESH_MARGIN_MS) {
      signed = await this.gateway.download(cloudAssetId);
      this.#downloadUrls.set(cloudAssetId, signed);
    }
    return signed;
  }

  #validateResponse(cloudAssetId: string, response: Response, expectedStatus: number): void {
    if (response.ok && response.status === expectedStatus) return;
    if (response.status === 401 || response.status === 403) {
      this.#downloadUrls.delete(cloudAssetId);
    }
    throw new Error(`Cloud original read failed (${response.status})`);
  }
}

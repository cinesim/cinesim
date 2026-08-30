import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { app, net } from "electron";
import { CINESIM_RENDERER_HOST, CINESIM_RENDERER_SCHEME, editorSession } from "./protocols";

const RENDERER_MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function rendererMimeType(path: string): string {
  return RENDERER_MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function rendererAssetPath(requestUrl: string, applicationPath: string): string | null {
  try {
    const rawPath = /^cinesim:\/\/app([^?#]*)/iu.exec(requestUrl)?.[1];
    if (!rawPath || /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/iu.test(rawPath)) return null;
    const url = new URL(requestUrl);
    if (url.protocol !== `${CINESIM_RENDERER_SCHEME}:` || url.hostname !== CINESIM_RENDERER_HOST)
      return null;
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\\") || pathname.includes("\0")) return null;
    const rendererDirectory = resolve(join(applicationPath, "dist", "renderer"));
    const assetPath = resolve(join(rendererDirectory, pathname.replace(/^\/+/, "")));
    const pathWithinRenderer = relative(rendererDirectory, assetPath);
    if (
      pathWithinRenderer === "" ||
      pathWithinRenderer === ".." ||
      pathWithinRenderer.startsWith(`..${sep}`) ||
      resolve(assetPath) === rendererDirectory
    )
      return null;
    return assetPath;
  } catch {
    return null;
  }
}

export function registerRendererProtocol(): void {
  editorSession().protocol.handle(CINESIM_RENDERER_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const path = rendererAssetPath(request.url, app.getAppPath());
    if (!path) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(path).href, { method: request.method });
    const headers = new Headers({
      "Content-Type": rendererMimeType(path),
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of ["content-length", "last-modified"] as const) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      headers,
    });
  });
}

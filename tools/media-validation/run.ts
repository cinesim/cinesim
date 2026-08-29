import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const buildDirectory = join(workspaceRoot, ".context/media-validation");
const fixtureDirectory = join(import.meta.dirname, "fixtures");
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

async function chromePath(): Promise<string> {
  const candidates = [
    process.env.CINESIM_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Chrome was not found; set CINESIM_CHROME_PATH to run media validation");
}

function resolveRequestPath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const base = decoded.startsWith("/fixtures/") ? fixtureDirectory : buildDirectory;
  const relative = decoded.startsWith("/fixtures/")
    ? decoded.slice("/fixtures/".length)
    : decoded === "/"
      ? "index.html"
      : decoded.slice(1);
  const candidate = normalize(join(base, relative));
  return candidate === base || candidate.startsWith(`${base}${sep}`) ? candidate : null;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function devToolsPort(profileDirectory: string, deadline: number): Promise<number> {
  const activePortPath = join(profileDirectory, "DevToolsActivePort");
  while (Date.now() < deadline) {
    try {
      const firstLine = (await readFile(activePortPath, "utf8")).split("\n", 1)[0];
      const port = Number(firstLine);
      if (Number.isSafeInteger(port) && port > 0) return port;
    } catch {
      await delay(50);
    }
  }
  throw new Error("Chrome did not expose its debugging port before the validation deadline");
}

interface DevToolsMessage {
  id?: number;
  result?: {
    result?: {
      value?: unknown;
    };
  };
  error?: { message: string };
}

class DevToolsConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (value: DevToolsMessage) => void; reject: (error: Error) => void }
  >();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as DevToolsMessage;
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message);
    });
  }

  static async connect(url: string): Promise<DevToolsConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome")), {
        once: true,
      });
    });
    return new DevToolsConnection(socket);
  }

  async evaluate(expression: string): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise<DevToolsMessage>((resolveMessage, reject) => {
      this.#pending.set(id, { resolve: resolveMessage, reject });
    });
    this.#socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }),
    );
    return (await response).result?.result?.value;
  }

  close(): void {
    this.#socket.close();
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = resolveRequestPath(url.pathname);
    if (!path) {
      response.writeHead(403).end();
      return;
    }
    const file = await stat(path);
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", mimeTypes[extname(path)] ?? "application/octet-stream");
    if (range) {
      const start = Number(range[1]);
      const requestedEnd = range[2] ? Number(range[2]) : file.size - 1;
      const end = Math.min(requestedEnd, file.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
        response.writeHead(416, { "Content-Range": `bytes */${file.size}` }).end();
        return;
      }
      response.writeHead(206, {
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${file.size}`,
      });
      createReadStream(path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { "Content-Length": file.size });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});

const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Media validation server did not bind");
const profileDirectory = await mkdtemp(join(tmpdir(), "cinesim-media-validation-"));
try {
  const chrome = await chromePath();
  const deadline = Date.now() + 45_000;
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,UseSkiaRenderer",
      "--use-angle=metal",
      "--disable-gpu-sandbox",
      "--disable-background-networking",
      "--disable-component-update",
      "--no-first-run",
      "--js-flags=--expose-gc",
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  try {
    const port = await devToolsPort(profileDirectory, deadline);
    const target = (await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${address.port}/`)}`,
      { method: "PUT" },
    ).then((response) => response.json())) as { webSocketDebuggerUrl?: string };
    if (!target.webSocketDebuggerUrl) throw new Error("Chrome did not create a validation target");
    const connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl);
    try {
      let result: unknown;
      while (Date.now() < deadline) {
        result = await connection.evaluate(`(() => {
          const element = document.querySelector("#result");
          return element ? { status: element.dataset.status, text: element.textContent } : null;
        })()`);
        if (
          result &&
          typeof result === "object" &&
          "status" in result &&
          (result.status === "passed" || result.status === "failed")
        )
          break;
        await delay(100);
      }
      if (!result || typeof result !== "object" || !("status" in result) || !("text" in result))
        throw new Error("Media validation did not finish before the deadline");
      if (result.status !== "passed" || typeof result.text !== "string")
        throw new Error(`Media validation failed: ${String(result.text)}`);
      const report = JSON.parse(result.text) as unknown;
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
      connection.close();
    }
  } catch (error) {
    const chromeErrors = Buffer.concat(errors).toString("utf8").slice(-4000);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${chromeErrors ? `\n${chromeErrors}` : ""}`,
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null)
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
} finally {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  await rm(profileDirectory, { recursive: true, force: true });
}

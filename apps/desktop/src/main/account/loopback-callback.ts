import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

export const LOCAL_AUTH_CALLBACK_HOST = "127.0.0.1";
export const LOCAL_AUTH_CALLBACK_PORT = 8788;
export const LOCAL_AUTH_CALLBACK_PATH = "/auth/callback";
export const LOCAL_AUTH_CALLBACK_URL = `http://${LOCAL_AUTH_CALLBACK_HOST}:${LOCAL_AUTH_CALLBACK_PORT}${LOCAL_AUTH_CALLBACK_PATH}`;

const callbackBodySchema = z.object({ token: z.string().min(1).max(4_096) });
const authorizationCodeSchema = z.object({
  identifier: z.string().min(1),
  state: z.string().min(1),
});

function authenticationAttemptKey(token: string): string {
  try {
    const decoded = authorizationCodeSchema.parse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
    );
    return `state:${createHash("sha256").update(decoded.state).digest("base64url")}`;
  } catch {
    return `token:${createHash("sha256").update(token).digest("base64url")}`;
  }
}

export interface LocalAuthCallbackServerOptions {
  allowedOrigin: string;
  onToken: (token: string) => Promise<void>;
  port?: number;
}

export class LocalAuthCallbackServer {
  readonly #options: LocalAuthCallbackServerOptions;
  readonly #completedAttempts = new Set<string>();
  readonly #inFlightAttempts = new Map<string, Promise<void>>();
  #server: Server | null = null;

  constructor(options: LocalAuthCallbackServerOptions) {
    this.#options = options;
  }

  start(): Promise<number> {
    if (this.#server) throw new Error("The local authentication callback is already running");
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    return new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(
        this.#options.port ?? LOCAL_AUTH_CALLBACK_PORT,
        LOCAL_AUTH_CALLBACK_HOST,
        () => {
          server.removeListener("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("The local authentication callback did not bind a TCP port"));
            return;
          }
          resolvePromise(address.port);
        },
      );
    });
  }

  close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const originAllowed = request.headers.origin === this.#options.allowedOrigin;
    response.setHeader("Vary", "Origin");
    if (originAllowed)
      response.setHeader("Access-Control-Allow-Origin", this.#options.allowedOrigin);

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader("Access-Control-Allow-Headers", "content-type");
      response.setHeader("Access-Control-Allow-Methods", "POST");
      response.writeHead(204).end();
      return;
    }

    if (request.method !== "POST" || request.url !== LOCAL_AUTH_CALLBACK_PATH || !originAllowed) {
      response.writeHead(404).end();
      return;
    }

    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > 8_192) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const input = callbackBodySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      await this.#deliverToken(input.token);
      response.writeHead(204).end();
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "authentication_callback_failed" }));
    }
  }

  async #deliverToken(token: string): Promise<void> {
    const key = authenticationAttemptKey(token);
    if (this.#completedAttempts.has(key)) return;

    const pending = this.#inFlightAttempts.get(key);
    if (pending) return pending;

    const attempt = Promise.resolve().then(() => this.#options.onToken(token));
    this.#inFlightAttempts.set(key, attempt);
    try {
      await attempt;
      this.#completedAttempts.add(key);
      while (this.#completedAttempts.size > 16) {
        const oldest = this.#completedAttempts.values().next().value;
        if (oldest) this.#completedAttempts.delete(oldest);
      }
    } finally {
      if (this.#inFlightAttempts.get(key) === attempt) this.#inFlightAttempts.delete(key);
    }
  }
}

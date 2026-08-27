import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

export const LOCAL_AUTH_CALLBACK_HOST = "127.0.0.1";
export const LOCAL_AUTH_CALLBACK_PORT = 8788;
export const LOCAL_AUTH_CALLBACK_PATH = "/auth/callback";
export const LOCAL_AUTH_CALLBACK_URL = `http://${LOCAL_AUTH_CALLBACK_HOST}:${LOCAL_AUTH_CALLBACK_PORT}${LOCAL_AUTH_CALLBACK_PATH}`;

const callbackBodySchema = z.object({ token: z.string().min(1).max(4_096) });

export interface LocalAuthCallbackServerOptions {
  allowedOrigin: string;
  onToken: (token: string) => Promise<void>;
  port?: number;
}

export class LocalAuthCallbackServer {
  readonly #options: LocalAuthCallbackServerOptions;
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
      await this.#options.onToken(input.token);
      response.writeHead(204).end();
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "authentication_callback_failed" }));
    }
  }
}

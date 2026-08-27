import { afterEach, describe, expect, it } from "vitest";
import {
  LocalAuthCallbackServer,
  LOCAL_AUTH_CALLBACK_PATH,
} from "../src/main/account/loopback-callback";

const allowedOrigin = "http://127.0.0.1:8787";
const servers: LocalAuthCallbackServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(onToken: (token: string) => Promise<void>): Promise<string> {
  const server = new LocalAuthCallbackServer({ allowedOrigin, onToken, port: 0 });
  servers.push(server);
  const port = await server.start();
  return `http://127.0.0.1:${port}${LOCAL_AUTH_CALLBACK_PATH}`;
}

describe("local desktop authentication callback", () => {
  it("accepts a callback only from the configured local auth origin", async () => {
    const received: string[] = [];
    const url = await startServer(async (token) => {
      received.push(token);
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: allowedOrigin },
      body: JSON.stringify({ token: "one-time-auth-code" }),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(received).toEqual(["one-time-auth-code"]);
  });

  it("rejects requests from another web origin", async () => {
    const received: string[] = [];
    const url = await startServer(async (token) => {
      received.push(token);
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ token: "must-not-be-forwarded" }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(received).toEqual([]);
  });

  it("answers browser preflight requests for the exact allowed origin", async () => {
    const url = await startServer(async () => undefined);
    const response = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });
});

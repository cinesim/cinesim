import { afterEach, describe, expect, it } from "vite-plus/test";
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

function authorizationCode(identifier: string, state: string): string {
  return Buffer.from(JSON.stringify({ identifier, state })).toString("base64url");
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

  it("accepts different authorization codes for the same one-time PKCE state only once", async () => {
    let deliveries = 0;
    const url = await startServer(async () => {
      deliveries += 1;
    });
    const request = (identifier: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: allowedOrigin },
        body: JSON.stringify({ token: authorizationCode(identifier, "shared-pkce-state") }),
      });

    const responses = await Promise.all([
      request("authorization-one"),
      request("authorization-two"),
    ]);
    const repeated = await request("authorization-three");

    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    expect(repeated.status).toBe(204);
    expect(deliveries).toBe(1);
  });

  it("allows a failed delivery to be retried", async () => {
    let deliveries = 0;
    const url = await startServer(async () => {
      deliveries += 1;
      if (deliveries === 1) throw new Error("transient failure");
    });
    const request = () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: allowedOrigin },
        body: JSON.stringify({ token: "retryable-one-time-auth-code" }),
      });

    expect((await request()).status).toBe(400);
    expect((await request()).status).toBe(204);
    expect(deliveries).toBe(2);
  });
});

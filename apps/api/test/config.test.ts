import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CINESIM_ENV: "development",
    CINESIM_DESKTOP_SCHEME: "build.cinesim.dev",
    BETTER_AUTH_URL: "http://127.0.0.1:8787",
    BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
    DATABASE_URL: "postgresql://cinesim:test@127.0.0.1:54329/cinesim",
    SMTP_URL: "smtp://127.0.0.1:1025",
    EMAIL_FROM: "Cinesim <hello@cinesim.local>",
    ...overrides,
  };
}

describe("Cinesim API configuration", () => {
  it("uses safe local defaults and leaves Google disabled without credentials", () => {
    const config = readServerConfig(environment());
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.authOrigin).toBe("http://127.0.0.1:8787");
    expect(config.google).toBeNull();
  });

  it("requires Google credentials as a pair", () => {
    expect(() => readServerConfig(environment({ GOOGLE_CLIENT_ID: "client-id" }))).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
  });

  it("requires HTTPS for deployed environments", () => {
    expect(() =>
      readServerConfig(
        environment({ CINESIM_ENV: "production", BETTER_AUTH_URL: "http://localhost:8787" }),
      ),
    ).toThrow(/HTTPS/);
  });

  it("accepts a production-ready HTTPS configuration", () => {
    const config = readServerConfig(
      environment({
        CINESIM_ENV: "production",
        CINESIM_DESKTOP_SCHEME: "build.cinesim.desktop",
        BETTER_AUTH_URL: "https://api.cinesim.example",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
      }),
    );
    expect(config.google).toEqual({ clientId: "client-id", clientSecret: "client-secret" });
  });
});

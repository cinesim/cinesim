import { describe, expect, it } from "vite-plus/test";
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
    expect(config.r2).toBeNull();
    expect(config.deepgramApiKey).toBeNull();
    expect(config.openRouterApiKey).toBeNull();
    expect(config.transcriptionLimits).toEqual({
      perUserConcurrency: 2,
      serviceConcurrency: 8,
      requestsPerMinute: 12,
      networkRequestsPerMinute: 30,
      userMonthlySeconds: 7_200,
      serviceMonthlySeconds: 360_000,
      maximumRequestSeconds: 600,
      providerTimeoutMs: 75_000,
    });
    expect(config.cloudIncludedBytes).toBe(10 * 1024 ** 3);
    expect(config.cloudAddonOptionsBytes).toEqual([0]);
  });

  it("keeps the Deepgram transcript-editing key server-side and optional", () => {
    expect(readServerConfig(environment({ DEEPGRAM_API_KEY: "test-deepgram-key" }))).toMatchObject({
      deepgramApiKey: "test-deepgram-key",
    });
  });

  it("keeps the OpenRouter transcription key server-side and optional", () => {
    expect(
      readServerConfig(environment({ OPENROUTER_API_KEY: "test-openrouter-key" })),
    ).toMatchObject({ openRouterApiKey: "test-openrouter-key" });
  });

  it("validates deployable transcription budgets and concurrency", () => {
    expect(
      readServerConfig(
        environment({
          CINESIM_TRANSCRIPTION_USER_CONCURRENCY: "3",
          CINESIM_TRANSCRIPTION_SERVICE_MONTHLY_SECONDS: "100000",
          CINESIM_TRANSCRIPTION_PROVIDER_TIMEOUT_MS: "45000",
        }),
      ).transcriptionLimits,
    ).toMatchObject({
      perUserConcurrency: 3,
      serviceMonthlySeconds: 100_000,
      providerTimeoutMs: 45_000,
    });
    expect(() =>
      readServerConfig(environment({ CINESIM_TRANSCRIPTION_USER_CONCURRENCY: "0" })),
    ).toThrow(/CINESIM_TRANSCRIPTION_USER_CONCURRENCY/);
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

  it("requires Cloudflare R2 credentials as a complete set", () => {
    expect(() => readServerConfig(environment({ CLOUDFLARE_R2_ACCOUNT_ID: "account-id" }))).toThrow(
      /R2 storage requires/,
    );
  });

  it("keeps R2 disabled when generated optional credentials are blank", () => {
    const config = readServerConfig(
      environment({
        CLOUDFLARE_R2_ACCOUNT_ID: "",
        CLOUDFLARE_R2_BUCKET: "",
        CLOUDFLARE_R2_ACCESS_KEY_ID: "",
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: "",
      }),
    );

    expect(config.r2).toBeNull();
  });

  it("enables R2 only with a complete private bucket configuration", () => {
    const config = readServerConfig(
      environment({
        CLOUDFLARE_R2_ACCOUNT_ID: "account-id",
        CLOUDFLARE_R2_BUCKET: "cinesim-originals-dev",
        CLOUDFLARE_R2_ACCESS_KEY_ID: "access-key",
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret-key",
        CINESIM_CLOUD_INCLUDED_BYTES: "21474836480",
        CINESIM_CLOUD_ADDON_OPTIONS_BYTES: "214748364800,0,53687091200",
      }),
    );
    expect(config.r2).toMatchObject({
      accountId: "account-id",
      bucket: "cinesim-originals-dev",
    });
    expect(config.cloudIncludedBytes).toBe(20 * 1024 ** 3);
    expect(config.cloudAddonOptionsBytes).toEqual([0, 50 * 1024 ** 3, 200 * 1024 ** 3]);
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

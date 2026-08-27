import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalEnvironment = { ...process.env };
let app: Awaited<typeof import("../src/app")>["default"];

beforeAll(async () => {
  Object.assign(process.env, {
    CINESIM_ENV: "test",
    CINESIM_DESKTOP_SCHEME: "build.cinesim.dev",
    BETTER_AUTH_URL: "http://127.0.0.1:8787",
    BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:54329/unused",
    SMTP_URL: "smtp://127.0.0.1:1025",
    EMAIL_FROM: "Cinesim <hello@cinesim.local>",
  });
  app = (await import("../src/app")).default;
});

afterAll(() => {
  for (const key of Object.keys(process.env))
    if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
});

describe("Hono authentication surface", () => {
  it("reports capabilities without exposing configuration", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      environment: "test",
      googleSignIn: false,
      cloudStorage: false,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the browser sign-in shell with strict security headers", async () => {
    const response = await app.request("/sign-in");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("font-src 'self' data:");
    const body = await response.text();
    expect(body).toContain("Continue to Cinesim");
    expect(body).not.toContain("Your projects remain local");
    expect(body).not.toContain("brand-mark");
    expect(body).not.toContain("test-secret-with-at-least-32-characters");
  });

  it("requires an account before exposing the project registry", async () => {
    const response = await app.request("/api/v1/projects");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

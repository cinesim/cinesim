import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AccountGateway } from "../src/main/account/gateway";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountGateway", () => {
  it("validates bounded account and health responses", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          user: {
            id: "user_fixture",
            name: "Cinesim",
            email: "cine@example.com",
            emailVerified: true,
            image: null,
          },
        }),
      ),
      new Response(
        JSON.stringify({
          ok: true,
          googleSignIn: false,
          cloudStorage: true,
          transcription: true,
        }),
      ),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()),
    );
    const gateway = new AccountGateway("https://cloud.cinesim.test", () => "session=fixture");

    await expect(gateway.account()).resolves.toMatchObject({ user: { id: "user_fixture" } });
    await expect(gateway.health()).resolves.toMatchObject({ cloudStorage: true });
  });

  it("rejects declared or streamed JSON beyond the account byte budget", async () => {
    const oversized = new Response("{}", { headers: { "content-length": "1048577" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => oversized),
    );
    const gateway = new AccountGateway("https://cloud.cinesim.test", () => "session=fixture");

    await expect(gateway.account()).rejects.toThrow("byte limit");
  });

  it("restricts authenticated calls to the versioned API and supplies the session cookie", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const gateway = new AccountGateway("https://cloud.cinesim.test", () => "session=fixture");

    await expect(gateway.authenticatedFetch("/health")).rejects.toThrow("Invalid Cinesim API");
    await gateway.authenticatedFetch("/api/v1/cloud/usage");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("cookie")).toBe("session=fixture");
  });
});

import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config";
import { LOCAL_DESKTOP_CALLBACK_URL } from "../src/local-desktop-callback";
import { authPage } from "../src/web-page";

const config: ServerConfig = {
  environment: "development",
  host: "127.0.0.1",
  port: 8787,
  desktopScheme: "build.cinesim.dev",
  authOrigin: "http://127.0.0.1:8787",
  authSecret: "not-rendered",
  databaseUrl: "not-rendered",
  smtpUrl: "not-rendered",
  emailFrom: "not-rendered",
  google: null,
};

describe("authentication page", () => {
  it("renders only public browser configuration", () => {
    const page = authPage(config);
    expect(page).toContain('content="build.cinesim.dev"');
    expect(page).toContain('content="false"');
    expect(page).toContain(`content="${LOCAL_DESKTOP_CALLBACK_URL}"`);
    expect(page).toContain('rel="icon" href="data:image/svg+xml');
    expect(page).not.toContain(config.authSecret);
    expect(page).not.toContain(config.databaseUrl);
  });

  it("does not expose the local callback in deployed environments", () => {
    const page = authPage({ ...config, environment: "production" });
    expect(page).toContain('name="cinesim-local-callback" content=""');
  });

  it("escapes the configured protocol before placing it in HTML", () => {
    const page = authPage({ ...config, desktopScheme: 'test"><script>alert(1)</script>' });
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&quot;&gt;&lt;script&gt;");
  });
});

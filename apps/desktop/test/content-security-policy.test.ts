import { describe, expect, it } from "vite-plus/test";
import {
  applyRendererContentSecurityPolicy,
  rendererContentSecurityPolicy,
  rendererContentSecurityPolicyPlaceholder,
} from "../content-security-policy";

describe("renderer content security policy", () => {
  it("keeps packaged renderers off localhost and WebSockets", () => {
    const policy = rendererContentSecurityPolicy(false);

    expect(policy).toContain("connect-src 'self' cinesim-media:");
    expect(policy).not.toContain("127.0.0.1");
    expect(policy).not.toContain("ws:");
    expect(policy).not.toContain("ws://");
    expect(policy).not.toContain("http:");
  });

  it("permits only the loopback Vite WebSocket during development", () => {
    const policy = rendererContentSecurityPolicy(true);

    expect(policy).toContain("connect-src 'self' ws://127.0.0.1:* cinesim-media:");
    expect(policy).not.toMatch(/(?:^|\s)ws:(?:\s|;|$)/);
    expect(policy).not.toContain("http://127.0.0.1");
  });

  it("requires and replaces the renderer HTML placeholder", () => {
    const html = `<meta content="${rendererContentSecurityPolicyPlaceholder}" />`;
    const transformed = applyRendererContentSecurityPolicy(html, false);

    expect(transformed).toContain(rendererContentSecurityPolicy(false));
    expect(transformed).not.toContain(rendererContentSecurityPolicyPlaceholder);
    expect(() => applyRendererContentSecurityPolicy("<html></html>", false)).toThrow(
      "missing its content-security-policy placeholder",
    );
  });
});

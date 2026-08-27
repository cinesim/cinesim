import { describe, expect, it } from "vitest";
import {
  encodeDesktopAuthorizationCode,
  shouldCompleteDesktopTransfer,
} from "../src/web/desktop-transfer";

describe("desktop authorization transfer", () => {
  it("waits for an explicit authentication choice on the initial page", () => {
    expect(
      shouldCompleteDesktopTransfer({
        client_id: "cinesim-desktop",
        state: "state456",
        code_challenge: "challenge789",
      }),
    ).toBe(false);
    expect(shouldCompleteDesktopTransfer({ auth_complete: "google" })).toBe(true);
    expect(shouldCompleteDesktopTransfer({ auth_complete: "email" })).toBe(true);
    expect(shouldCompleteDesktopTransfer({ verified: "true" })).toBe(true);
    expect(shouldCompleteDesktopTransfer({ oauth_error: "true" })).toBe(false);
  });

  it("encodes the official Better Auth identifier and state payload", () => {
    const code = encodeDesktopAuthorizationCode("identifier123", "state456");
    const base64 = code.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    expect(JSON.parse(atob(padded))).toEqual({
      identifier: "identifier123",
      state: "state456",
    });
  });

  it("rejects malformed transfer values", () => {
    expect(() => encodeDesktopAuthorizationCode("identifier:123", "state456")).toThrow("invalid");
  });
});

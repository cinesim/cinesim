import { describe, expect, it } from "vite-plus/test";
import { parseDesktopAuthCallback } from "../src/shared/auth-callback";

describe("desktop authentication callback", () => {
  it("accepts only the exact scheme, path, and fragment token", () => {
    expect(
      parseDesktopAuthCallback(
        "build.cinesim.dev://auth/callback#token=authorization-code",
        "build.cinesim.dev",
      ),
    ).toBe("authorization-code");
  });

  it("rejects other schemes and paths", () => {
    expect(
      parseDesktopAuthCallback(
        "build.cinesim.desktop://auth/callback#token=authorization-code",
        "build.cinesim.dev",
      ),
    ).toBeNull();
    expect(
      parseDesktopAuthCallback(
        "build.cinesim.dev://other#token=authorization-code",
        "build.cinesim.dev",
      ),
    ).toBeNull();
    expect(
      parseDesktopAuthCallback(
        "build.cinesim.dev://auth/callback?token=authorization-code",
        "build.cinesim.dev",
      ),
    ).toBeNull();
  });
});

import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseSingleByteRange, unsatisfiedRangeResponse } from "../src/main/app/http-range";
import { rendererAssetPath } from "../src/main/app/renderer-protocol";
import { trustedMediaRequestOrigin } from "../src/main/derived-media/media-protocol";

describe("desktop protocol policy", () => {
  it("parses only one satisfiable byte range", () => {
    expect(parseSingleByteRange(null, 100)).toEqual({
      kind: "full",
      start: 0,
      endExclusive: 100,
    });
    expect(parseSingleByteRange("bytes=10-19", 100)).toEqual({
      kind: "range",
      start: 10,
      endExclusive: 20,
    });
    expect(parseSingleByteRange("bytes=90-", 100)).toEqual({
      kind: "range",
      start: 90,
      endExclusive: 100,
    });
    expect(parseSingleByteRange("bytes=-10", 100)).toEqual({
      kind: "range",
      start: 90,
      endExclusive: 100,
    });
    for (const value of ["bytes=0-1,3-4", "items=0-1", "bytes=100-", "bytes=9-2", "bytes=-0"])
      expect(parseSingleByteRange(value, 100)).toEqual({ kind: "invalid" });
  });

  it("returns standards-compliant unsatisfied range responses", () => {
    const response = unsatisfiedRangeResponse(47, "cinesim://app");
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */47");
    expect(response.headers.get("access-control-allow-origin")).toBe("cinesim://app");
  });

  it("accepts media reads only from the packaged or configured development origin", () => {
    const packagedRequest = new Request("cinesim-media://asset/scope/id", {
      headers: { Origin: "cinesim://app" },
    });
    const developmentRequest = new Request("cinesim-media://asset/scope/id", {
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    const attackerRequest = new Request("cinesim-media://asset/scope/id", {
      headers: { Origin: "https://attacker.invalid" },
    });
    expect(trustedMediaRequestOrigin(packagedRequest)).toBe("cinesim://app");
    expect(
      trustedMediaRequestOrigin(developmentRequest, new URL("http://127.0.0.1:5173/editor")),
    ).toBe("http://127.0.0.1:5173");
    expect(trustedMediaRequestOrigin(attackerRequest)).toBeNull();
    expect(trustedMediaRequestOrigin(new Request("cinesim-media://asset/scope/id"))).toBeNull();
  });

  it("maps renderer resources beneath the packaged renderer directory", () => {
    const applicationPath = "/Applications/Cinesim.app/Contents/Resources/app.asar";
    expect(rendererAssetPath("cinesim://app/index.html", applicationPath)).toBe(
      join(applicationPath, "dist", "renderer", "index.html"),
    );
    expect(rendererAssetPath("cinesim://app/assets/editor.js", applicationPath)).toBe(
      join(applicationPath, "dist", "renderer", "assets", "editor.js"),
    );
    for (const url of [
      "cinesim://foreign/index.html",
      "https://app/index.html",
      "cinesim://app/",
      "cinesim://app/%2e%2e/main/main.js",
      "cinesim://app/assets%5cmain.js",
      "cinesim://app/assets%00main.js",
    ])
      expect(rendererAssetPath(url, applicationPath)).toBeNull();
  });
});

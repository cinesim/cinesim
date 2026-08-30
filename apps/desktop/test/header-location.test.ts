import { describe, expect, it } from "vite-plus/test";
import { headerLocationMotion } from "../src/renderer/components/shell/animated-header-location";

describe("header location motion", () => {
  it("moves vertically according to navigation depth", () => {
    expect(headerLocationMotion(0, 1)).toBe("deeper");
    expect(headerLocationMotion(1, 0)).toBe("shallower");
  });

  it("crossfades replacements at the same depth", () => {
    expect(headerLocationMotion(1, 1)).toBe("replace");
  });
});

import { describe, expect, it } from "vitest";
import { isAgentsSidebarShortcut } from "../src/renderer/components/app-shell";

describe("keyboard shortcuts", () => {
  it("recognizes Option+Command+B by physical key code", () => {
    expect(
      isAgentsSidebarShortcut({
        altKey: true,
        code: "KeyB",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("does not confuse the agents shortcut with Command+B or Control+Command+B", () => {
    const baseEvent = {
      code: "KeyB",
      metaKey: true,
      shiftKey: false,
    };

    expect(isAgentsSidebarShortcut({ ...baseEvent, altKey: false, ctrlKey: false })).toBe(false);
    expect(isAgentsSidebarShortcut({ ...baseEvent, altKey: false, ctrlKey: true })).toBe(false);
  });
});

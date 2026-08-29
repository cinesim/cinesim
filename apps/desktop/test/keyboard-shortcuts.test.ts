import { describe, expect, it } from "vite-plus/test";
import {
  isAgentsSidebarShortcut,
  projectSectionForShortcut,
  toggleAuxiliaryMode,
} from "../src/renderer/components/shell/app-shell";

describe("keyboard shortcuts", () => {
  it("keeps the auxiliary sidebars mutually exclusive", () => {
    expect(toggleAuxiliaryMode(null, "metrics")).toBe("metrics");
    expect(toggleAuxiliaryMode("metrics", "metrics")).toBeNull();
    expect(toggleAuxiliaryMode("agents", "metrics")).toBe("metrics");
    expect(toggleAuxiliaryMode("metrics", "agents")).toBe("agents");
  });

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

  it("maps command-number shortcuts to project sections", () => {
    const commandEvent = {
      altKey: false,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    };

    expect(projectSectionForShortcut({ ...commandEvent, key: "1" })).toBe("media");
    expect(projectSectionForShortcut({ ...commandEvent, key: "2" })).toBe("cut");
    expect(projectSectionForShortcut({ ...commandEvent, key: "3" })).toBe("edit");
  });

  it("rejects project-section shortcuts with extra modifiers", () => {
    const baseEvent = {
      ctrlKey: false,
      key: "1",
      metaKey: true,
      shiftKey: false,
    };

    expect(projectSectionForShortcut({ ...baseEvent, altKey: true })).toBeNull();
    expect(projectSectionForShortcut({ ...baseEvent, altKey: false, shiftKey: true })).toBeNull();
  });
});

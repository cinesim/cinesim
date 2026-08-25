import { describe, expect, it } from "vitest";
import { editShortcutAction } from "../src/renderer/lib/edit-shortcuts";

describe("edit shortcuts", () => {
  it.each([
    ["a", "select-tool"],
    ["T", "trim-tool"],
    ["b", "blade-tool"],
    ["s", "toggle-snapping"],
  ] as const)("maps %s to %s", (key, action) => {
    expect(editShortcutAction({ key })).toBe(action);
  });

  it("uses the Resolve-style primary-backslash chord for a split", () => {
    expect(editShortcutAction({ key: "\\", metaKey: true })).toBe("split-selection");
    expect(editShortcutAction({ key: "\\", ctrlKey: true })).toBe("split-selection");
  });

  it("maps both platform deletion keys and ignores modified tool keys", () => {
    expect(editShortcutAction({ key: "Backspace", code: "Backspace" })).toBe("delete-selection");
    expect(editShortcutAction({ key: "Delete", code: "Delete" })).toBe("delete-selection");
    expect(editShortcutAction({ key: "b", metaKey: true })).toBeNull();
    expect(editShortcutAction({ key: "s", shiftKey: true })).toBeNull();
  });
});

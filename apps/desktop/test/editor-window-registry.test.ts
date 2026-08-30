import { describe, expect, it, vi } from "vite-plus/test";
import { EditorWindowRegistry } from "../src/main/app/editor-window-registry";
import { desktopEvents } from "../src/shared/contracts/events";

function editorWindow() {
  let closed: (() => void) | undefined;
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "closed") closed = listener;
    }),
    webContents: { send: vi.fn() },
  };
  return { window, close: () => closed?.() };
}

describe("EditorWindowRegistry", () => {
  it("broadcasts typed events only to explicitly registered live editor windows", () => {
    const registry = new EditorWindowRegistry();
    const first = editorWindow();
    const second = editorWindow();
    registry.register(first.window as never);
    registry.register(second.window as never);

    registry.broadcast(desktopEvents.projectChanged, { revision: 7 } as never);
    expect(first.window.webContents.send).toHaveBeenCalledWith("project:changed", {
      revision: 7,
    });
    expect(second.window.webContents.send).toHaveBeenCalledOnce();

    first.close();
    registry.broadcast(desktopEvents.authError);
    expect(first.window.webContents.send).toHaveBeenCalledOnce();
    expect(second.window.webContents.send).toHaveBeenLastCalledWith("cinesim-auth:error");
  });

  it("owns primary-window focus and visibility behavior", () => {
    const registry = new EditorWindowRegistry();
    const editor = editorWindow();
    editor.window.isMinimized.mockReturnValue(true);
    registry.register(editor.window as never);

    expect(registry.focusPrimary({ show: true })).toBe(editor.window);
    expect(editor.window.restore).toHaveBeenCalledOnce();
    expect(editor.window.show).toHaveBeenCalledOnce();
    expect(editor.window.focus).toHaveBeenCalledOnce();
  });
});

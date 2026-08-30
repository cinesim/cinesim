import { describe, expect, it, vi } from "vite-plus/test";
import {
  denyPermissionCheck,
  denyPermissionRequest,
  editorWebPreferences,
  installEditorNavigationPolicy,
} from "../src/main/app/editor-security";
import { CINESIM_RENDERER_ENTRY_URL, EDITOR_SESSION_PARTITION } from "../src/main/app/protocols";

describe("packaged editor security policy", () => {
  it("uses the custom renderer entry and an isolated sandboxed session", () => {
    expect(CINESIM_RENDERER_ENTRY_URL).toBe("cinesim://app/index.html");
    expect(editorWebPreferences("/app/preload.cjs")).toEqual({
      preload: "/app/preload.cjs",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: EDITOR_SESSION_PARTITION,
    });
  });

  it("denies permissions, popups, and renderer navigation", () => {
    const permissionCallback = vi.fn();
    expect(denyPermissionCheck()).toBe(false);
    denyPermissionRequest({} as never, "camera", permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    let navigationHandler: ((event: { preventDefault(): void }) => void) | undefined;
    const webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: typeof navigationHandler) => {
        if (event === "will-navigate") navigationHandler = handler;
      }),
    };
    installEditorNavigationPolicy(webContents as never);
    expect(webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
    const preventDefault = vi.fn();
    navigationHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

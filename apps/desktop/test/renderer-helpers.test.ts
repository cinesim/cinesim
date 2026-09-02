import { describe, expect, it } from "vite-plus/test";
import { buildAgentTurnContext } from "../src/renderer/hooks/use-agent-project-controller";
import { activeAppRoute } from "../src/renderer/hooks/use-app-route-controller";
import {
  clampSidebarWidth,
  readPersistentSidebarWidth,
} from "../src/renderer/hooks/use-persistent-sidebar-width";
import { formatByteCount, formatDiagnosticDurationMs } from "../src/renderer/lib/format";

describe("renderer helpers", () => {
  it("falls back home when the project route has no available project", () => {
    expect(activeAppRoute("project", false)).toBe("home");
    expect(activeAppRoute("project", true)).toBe("project");
    expect(activeAppRoute("settings", false)).toBe("settings");
  });

  it("clamps restored sidebar widths and falls back for invalid values", () => {
    expect(clampSidebarWidth(500, 220, 420)).toBe(420);
    expect(clampSidebarWidth(100, 220, 420)).toBe(220);
    expect(readPersistentSidebarWidth("not-a-number", 220, 420, 272)).toBe(272);
    expect(readPersistentSidebarWidth("390", 220, 420, 272)).toBe(390);
  });

  it("builds the next agent turn from current editor context", () => {
    const session = {
      diskValid: false,
      diagnostics: [],
      candidateDiagnostics: [{ severity: "error", code: "CS100", message: "Broken source" }],
    } satisfies Parameters<typeof buildAgentTurnContext>[0]["session"];
    expect(
      buildAgentTurnContext({
        workspace: "edit",
        activeSequenceId: "sequence_cut",
        playheadUs: 2_500_000,
        selectedAssetIds: ["asset_selected"],
        selectedClipId: "clip_selected",
        session,
      }),
    ).toEqual({
      workspace: "edit",
      activeSequenceId: "sequence_cut",
      playheadUs: 2_500_000,
      selectedIds: ["asset_selected", "clip_selected"],
      selectedAssetIds: ["asset_selected"],
      selectedClipIds: ["clip_selected"],
      compiler: {
        diskValid: false,
        diagnosticCount: 1,
        diagnostics: [{ code: "CS100", message: "Broken source" }],
      },
    });
    expect(
      buildAgentTurnContext({
        workspace: "media",
        activeSequenceId: null,
        playheadUs: 0,
        selectedAssetIds: [],
        selectedClipId: null,
        session: { ...session, diskValid: true, diagnostics: [], candidateDiagnostics: [] },
      }),
    ).toEqual({
      workspace: "media",
      playheadUs: 0,
      compiler: { diskValid: true, diagnosticCount: 0, diagnostics: [] },
    });
  });

  it("uses shared diagnostic formatters", () => {
    expect(formatByteCount(1_536)).toBe("1.5 KB");
    expect(formatDiagnosticDurationMs(1_250)).toBe("1.25 s");
  });
});

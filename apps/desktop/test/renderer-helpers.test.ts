import { describe, expect, it } from "vitest";
import { buildAgentTurnContext } from "../src/renderer/agents/use-agent-project-controller";
import {
  clampSidebarWidth,
  readPersistentSidebarWidth,
} from "../src/renderer/hooks/use-persistent-sidebar-width";
import { formatByteCount, formatDiagnosticDurationMs } from "../src/renderer/lib/format";

describe("renderer helpers", () => {
  it("clamps restored sidebar widths and falls back for invalid values", () => {
    expect(clampSidebarWidth(500, 220, 420)).toBe(420);
    expect(clampSidebarWidth(100, 220, 420)).toBe(220);
    expect(readPersistentSidebarWidth("not-a-number", 220, 420, 272)).toBe(272);
    expect(readPersistentSidebarWidth("390", 220, 420, 272)).toBe(390);
  });

  it("builds the next agent turn from current editor context", () => {
    expect(buildAgentTurnContext("sequence_cut", 2_500_000, "clip_selected")).toEqual({
      activeSequenceId: "sequence_cut",
      playheadUs: 2_500_000,
      selectedIds: ["clip_selected"],
    });
    expect(buildAgentTurnContext(null, 0, null)).toEqual({ playheadUs: 0 });
  });

  it("uses shared diagnostic formatters", () => {
    expect(formatByteCount(1_536)).toBe("1.5 KB");
    expect(formatDiagnosticDurationMs(1_250)).toBe("1.25 s");
  });
});

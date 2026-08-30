import { describe, expect, it } from "vite-plus/test";
import {
  EDITOR_SPLITTER_SIZE,
  MIN_EDITOR_VIEWER_HEIGHT,
  editorRootGridTemplate,
  editorUpperGridTemplate,
  fitEditorLayout,
} from "../src/renderer/lib/editor-layout";

const storedLayout = {
  mediaPoolWidth: 360,
  inspectorWidth: 300,
  notesWidth: 320,
  timelineHeight: 300,
};

describe("Edit workspace layout", () => {
  it("preserves a stored layout when the workspace has enough room", () => {
    const panels = { mediaPool: true, inspector: true, notes: true };
    const fitted = fitEditorLayout(storedLayout, { width: 1_600, height: 900 }, panels);

    expect(fitted).toEqual(storedLayout);
    expect(editorRootGridTemplate(fitted)).toBe("minmax(220px, 1fr) 1px 300px");
    expect(editorUpperGridTemplate(fitted, panels)).toBe(
      "360px 1px minmax(320px, 1fr) 1px 300px 1px 320px",
    );
  });

  it("fits open panels while preserving the stored widths of closed panels", () => {
    const fitted = fitEditorLayout(
      storedLayout,
      { width: 760, height: 500 },
      {
        mediaPool: true,
        inspector: false,
        notes: false,
      },
    );

    expect(fitted).toEqual({
      mediaPoolWidth: 360,
      inspectorWidth: storedLayout.inspectorWidth,
      notesWidth: storedLayout.notesWidth,
      timelineHeight: 279,
    });
  });

  it("keeps configured minimums when the workspace is smaller than its panels", () => {
    const fitted = fitEditorLayout(
      storedLayout,
      { width: 640, height: 240 },
      {
        mediaPool: true,
        inspector: true,
        notes: true,
      },
    );

    expect(fitted).toEqual({
      mediaPoolWidth: 180,
      inspectorWidth: 220,
      notesWidth: 220,
      timelineHeight: 64,
    });
    expect(MIN_EDITOR_VIEWER_HEIGHT + EDITOR_SPLITTER_SIZE + fitted.timelineHeight).toBe(285);
  });
});

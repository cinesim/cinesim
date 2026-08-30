import { EDITOR_LAYOUT_LIMITS } from "../../shared/contracts";
import type { EditorLayoutState } from "../../shared/contracts";

export const EDITOR_SPLITTER_SIZE = 1;
export const MIN_EDITOR_VIEWER_WIDTH = 320;
export const MIN_EDITOR_VIEWER_HEIGHT = 220;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function fitEditorLayout(
  layout: EditorLayoutState,
  bounds: { width: number; height: number },
  panels: { mediaPool: boolean; inspector: boolean; notes: boolean },
): EditorLayoutState {
  const splitterCount = Number(panels.mediaPool) + Number(panels.inspector) + Number(panels.notes);
  const notesAvailable =
    bounds.width > 0
      ? bounds.width -
        MIN_EDITOR_VIEWER_WIDTH -
        EDITOR_SPLITTER_SIZE * splitterCount -
        (panels.mediaPool ? EDITOR_LAYOUT_LIMITS.mediaPoolWidth.min : 0) -
        (panels.inspector ? EDITOR_LAYOUT_LIMITS.inspectorWidth.min : 0)
      : EDITOR_LAYOUT_LIMITS.notesWidth.max;
  const notesWidth = panels.notes
    ? clamp(
        layout.notesWidth,
        EDITOR_LAYOUT_LIMITS.notesWidth.min,
        Math.min(EDITOR_LAYOUT_LIMITS.notesWidth.max, notesAvailable),
      )
    : layout.notesWidth;
  const inspectorAvailable =
    bounds.width > 0
      ? bounds.width -
        MIN_EDITOR_VIEWER_WIDTH -
        EDITOR_SPLITTER_SIZE * splitterCount -
        (panels.mediaPool ? EDITOR_LAYOUT_LIMITS.mediaPoolWidth.min : 0) -
        (panels.notes ? notesWidth : 0)
      : EDITOR_LAYOUT_LIMITS.inspectorWidth.max;
  const inspectorWidth = panels.inspector
    ? clamp(
        layout.inspectorWidth,
        EDITOR_LAYOUT_LIMITS.inspectorWidth.min,
        Math.min(EDITOR_LAYOUT_LIMITS.inspectorWidth.max, inspectorAvailable),
      )
    : layout.inspectorWidth;
  const mediaAvailable =
    bounds.width > 0
      ? bounds.width -
        MIN_EDITOR_VIEWER_WIDTH -
        EDITOR_SPLITTER_SIZE * splitterCount -
        (panels.inspector ? inspectorWidth : 0) -
        (panels.notes ? notesWidth : 0)
      : EDITOR_LAYOUT_LIMITS.mediaPoolWidth.max;
  const timelineAvailable =
    bounds.height > 0
      ? bounds.height - MIN_EDITOR_VIEWER_HEIGHT - EDITOR_SPLITTER_SIZE
      : EDITOR_LAYOUT_LIMITS.timelineHeight.max;

  return {
    mediaPoolWidth: panels.mediaPool
      ? clamp(
          layout.mediaPoolWidth,
          EDITOR_LAYOUT_LIMITS.mediaPoolWidth.min,
          Math.min(EDITOR_LAYOUT_LIMITS.mediaPoolWidth.max, mediaAvailable),
        )
      : layout.mediaPoolWidth,
    inspectorWidth,
    notesWidth,
    timelineHeight: clamp(
      layout.timelineHeight,
      EDITOR_LAYOUT_LIMITS.timelineHeight.min,
      Math.min(EDITOR_LAYOUT_LIMITS.timelineHeight.max, timelineAvailable),
    ),
  };
}

export function editorRootGridTemplate(layout: EditorLayoutState): string {
  return `minmax(${MIN_EDITOR_VIEWER_HEIGHT}px, 1fr) ${EDITOR_SPLITTER_SIZE}px ${layout.timelineHeight}px`;
}

export function editorUpperGridTemplate(
  layout: EditorLayoutState,
  panels: { mediaPool: boolean; inspector: boolean; notes: boolean },
): string {
  const columns: string[] = [];
  if (panels.mediaPool) columns.push(`${layout.mediaPoolWidth}px`, `${EDITOR_SPLITTER_SIZE}px`);
  columns.push(`minmax(${MIN_EDITOR_VIEWER_WIDTH}px, 1fr)`);
  if (panels.inspector) columns.push(`${EDITOR_SPLITTER_SIZE}px`, `${layout.inspectorWidth}px`);
  if (panels.notes) columns.push(`${EDITOR_SPLITTER_SIZE}px`, `${layout.notesWidth}px`);
  return columns.join(" ");
}

import { EDITOR_LAYOUT_LIMITS } from "../../shared/contracts";
import type { EditorLayoutState } from "../../shared/contracts";

export const EDITOR_SPLITTER_SIZE = 1;
export const MIN_EDITOR_VIEWER_WIDTH = 320;
export const MIN_EDITOR_VIEWER_HEIGHT = 220;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function enabledWidth(enabled: boolean, width: number): number {
  return enabled ? width : 0;
}

function availablePanelWidth(
  boundsWidth: number,
  splitterCount: number,
  occupiedWidths: readonly number[],
  fallback: number,
): number {
  if (boundsWidth <= 0) return fallback;
  return (
    boundsWidth -
    MIN_EDITOR_VIEWER_WIDTH -
    EDITOR_SPLITTER_SIZE * splitterCount -
    occupiedWidths.reduce((total, width) => total + width, 0)
  );
}

function fitOptionalPanel(
  enabled: boolean,
  current: number,
  limits: { min: number; max: number },
  available: number,
): number {
  return enabled ? clamp(current, limits.min, Math.min(limits.max, available)) : current;
}

export function fitEditorLayout(
  layout: EditorLayoutState,
  bounds: { width: number; height: number },
  panels: { mediaPool: boolean; inspector: boolean; notes: boolean },
): EditorLayoutState {
  const splitterCount = Number(panels.mediaPool) + Number(panels.inspector) + Number(panels.notes);
  const notesAvailable = availablePanelWidth(
    bounds.width,
    splitterCount,
    [
      enabledWidth(panels.mediaPool, EDITOR_LAYOUT_LIMITS.mediaPoolWidth.min),
      enabledWidth(panels.inspector, EDITOR_LAYOUT_LIMITS.inspectorWidth.min),
    ],
    EDITOR_LAYOUT_LIMITS.notesWidth.max,
  );
  const notesWidth = fitOptionalPanel(
    panels.notes,
    layout.notesWidth,
    EDITOR_LAYOUT_LIMITS.notesWidth,
    notesAvailable,
  );
  const inspectorAvailable = availablePanelWidth(
    bounds.width,
    splitterCount,
    [
      enabledWidth(panels.mediaPool, EDITOR_LAYOUT_LIMITS.mediaPoolWidth.min),
      enabledWidth(panels.notes, notesWidth),
    ],
    EDITOR_LAYOUT_LIMITS.inspectorWidth.max,
  );
  const inspectorWidth = fitOptionalPanel(
    panels.inspector,
    layout.inspectorWidth,
    EDITOR_LAYOUT_LIMITS.inspectorWidth,
    inspectorAvailable,
  );
  const mediaAvailable = availablePanelWidth(
    bounds.width,
    splitterCount,
    [enabledWidth(panels.inspector, inspectorWidth), enabledWidth(panels.notes, notesWidth)],
    EDITOR_LAYOUT_LIMITS.mediaPoolWidth.max,
  );
  const timelineAvailable =
    bounds.height <= 0
      ? EDITOR_LAYOUT_LIMITS.timelineHeight.max
      : bounds.height - MIN_EDITOR_VIEWER_HEIGHT - EDITOR_SPLITTER_SIZE;

  return {
    mediaPoolWidth: fitOptionalPanel(
      panels.mediaPool,
      layout.mediaPoolWidth,
      EDITOR_LAYOUT_LIMITS.mediaPoolWidth,
      mediaAvailable,
    ),
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

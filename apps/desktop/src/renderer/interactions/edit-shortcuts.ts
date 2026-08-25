export type EditShortcutAction =
  | "select-tool"
  | "trim-tool"
  | "blade-tool"
  | "toggle-snapping"
  | "delete-selection"
  | "split-selection";

export interface EditShortcutInput {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Resolve timeline shortcuts without coupling keyboard policy to React. */
export function editShortcutAction(input: EditShortcutInput): EditShortcutAction | null {
  const key = input.key.toLowerCase();
  const primary = Boolean(input.metaKey || input.ctrlKey);
  if (primary && !input.altKey && !input.shiftKey && key === "\\") return "split-selection";
  if (primary || input.altKey || input.shiftKey) return null;
  if (key === "a") return "select-tool";
  if (key === "t") return "trim-tool";
  if (key === "b") return "blade-tool";
  if (key === "s") return "toggle-snapping";
  if (input.code === "Delete" || input.code === "Backspace") return "delete-selection";
  return null;
}

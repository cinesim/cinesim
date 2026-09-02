import { useEffect } from "react";
import { isEditableKeyboardTarget } from "../lib/keyboard-target";
import type { AuxiliarySidebarMode, Destination, ProjectSection } from "../store/renderer-store";

export function toggleAuxiliaryMode(
  current: AuxiliarySidebarMode,
  requested: Exclude<AuxiliarySidebarMode, null>,
): AuxiliarySidebarMode {
  return current === requested ? null : requested;
}

export function isAgentsSidebarShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return (
    event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyB"
  );
}

export function projectSectionForShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): ProjectSection | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  if (event.key === "1") return "media";
  if (event.key === "2") return "cut";
  if (event.key === "3") return "edit";
  if (event.key === "4") return "effects";
  return null;
}

interface ShellShortcutOptions {
  destination: Destination;
  agentsSidebarAvailable: boolean;
  auxiliaryMode: AuxiliarySidebarMode;
  onAuxiliaryMode: (mode: AuxiliarySidebarMode) => void;
  onHome: () => void;
  onProjectSection: (section: ProjectSection) => void;
  onToggleSidebar: () => void;
  onToggleShortcuts: () => void;
  onCloseShortcuts: () => void;
}

type ShellShortcut =
  | { type: "agents" }
  | { type: "project-section"; section: ProjectSection }
  | { type: "sidebar" }
  | { type: "home" }
  | { type: "shortcuts" }
  | { type: "escape" };

function plainCommand(event: KeyboardEvent, key: string): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === key
  );
}

function identifyShortcut(event: KeyboardEvent, destination: Destination): ShellShortcut | null {
  if (isAgentsSidebarShortcut(event)) return { type: "agents" };
  const section =
    destination === "project" && !isEditableKeyboardTarget(event.target)
      ? projectSectionForShortcut(event)
      : null;
  if (section) return { type: "project-section", section };
  if (plainCommand(event, "b")) return { type: "sidebar" };
  if (plainCommand(event, "/")) return { type: "shortcuts" };
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey && event.key === "h") {
    return { type: "home" };
  }
  return !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key === "Escape"
    ? { type: "escape" }
    : null;
}

export function useShellShortcuts(options: ShellShortcutOptions): void {
  const {
    destination,
    agentsSidebarAvailable,
    auxiliaryMode,
    onAuxiliaryMode,
    onHome,
    onProjectSection,
    onToggleSidebar,
    onToggleShortcuts,
    onCloseShortcuts,
  } = options;

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const action = identifyShortcut(event, destination);
      if (!action || (action.type === "agents" && !agentsSidebarAvailable)) return;
      if (action.type !== "escape") event.preventDefault();
      switch (action.type) {
        case "agents":
          onAuxiliaryMode(toggleAuxiliaryMode(auxiliaryMode, "agents"));
          break;
        case "project-section":
          onProjectSection(action.section);
          break;
        case "sidebar":
          onToggleSidebar();
          break;
        case "home":
          onCloseShortcuts();
          onHome();
          break;
        case "shortcuts":
          onToggleShortcuts();
          break;
        case "escape":
          onCloseShortcuts();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [
    agentsSidebarAvailable,
    auxiliaryMode,
    destination,
    onAuxiliaryMode,
    onCloseShortcuts,
    onHome,
    onProjectSection,
    onToggleShortcuts,
    onToggleSidebar,
  ]);
}

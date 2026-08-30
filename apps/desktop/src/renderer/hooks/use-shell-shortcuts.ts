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
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const projectSection =
        destination === "project" && !isEditableKeyboardTarget(event.target)
          ? projectSectionForShortcut(event)
          : null;
      if (isAgentsSidebarShortcut(event)) {
        if (agentsSidebarAvailable) {
          event.preventDefault();
          onAuxiliaryMode(toggleAuxiliaryMode(auxiliaryMode, "agents"));
        }
      } else if (projectSection) {
        event.preventDefault();
        onProjectSection(projectSection);
      } else if (command && !event.altKey && !event.shiftKey && key === "b") {
        event.preventDefault();
        onToggleSidebar();
      } else if (command && !event.altKey && event.shiftKey && key === "h") {
        event.preventDefault();
        onCloseShortcuts();
        onHome();
      } else if (command && !event.altKey && !event.shiftKey && key === "/") {
        event.preventDefault();
        onToggleShortcuts();
      } else if (!command && !event.altKey && !event.shiftKey && key === "escape") {
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

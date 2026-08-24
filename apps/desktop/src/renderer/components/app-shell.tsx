import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  House,
  Keyboard,
  Library,
  Scissors,
  SlidersHorizontal,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@cinesim/ui";
import type { DesktopAppState, DesktopProjectSession } from "../../shared/api";
import { usePersistentSidebarWidth } from "../hooks/use-persistent-sidebar-width";
import { ProjectBreadcrumb } from "./project-breadcrumb";
import { ShortcutHint, ShortcutsDialog } from "./shortcuts-dialog";

interface AppShellProps {
  session: DesktopProjectSession | null;
  appState: DesktopAppState;
  destination: "home" | "project" | "settings";
  projectSection: "media" | "edit";
  activeSequenceId: string | null;
  settingsSection: "general" | "agents";
  title: string;
  leadingToolbar?: React.ReactNode;
  toolbar: React.ReactNode;
  onHome: () => void;
  onProjectSection: (section: "media" | "edit") => void;
  onTimeline: (sequenceId: string) => void;
  onSettings: () => void;
  onSettingsSection: (section: "general" | "agents") => void;
  onOpenRecent: (directory: string) => void;
  onOpenProject: () => void;
  agentsSidebar?: React.ReactNode;
  metricsSidebar?: React.ReactNode;
  auxiliaryMode: AuxiliarySidebarMode;
  onAuxiliaryMode: (mode: AuxiliarySidebarMode) => void;
  children: React.ReactNode;
}

export type AuxiliarySidebarMode = "agents" | "metrics" | null;

export function toggleAuxiliaryMode(
  current: AuxiliarySidebarMode,
  requested: Exclude<AuxiliarySidebarMode, null>,
): AuxiliarySidebarMode {
  return current === requested ? null : requested;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_SIDEBAR_WIDTH = 272;
const MIN_AGENTS_SIDEBAR_WIDTH = 260;
const MAX_AGENTS_SIDEBAR_WIDTH = 420;
const DEFAULT_AGENTS_SIDEBAR_WIDTH = 320;
const SIDEBAR_OPEN_STORAGE_KEY = "cinesim.sidebarOpen";

function availableSidebarWidth(): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 740));
}

function initialSidebarOpen(storageKey: string): boolean {
  return localStorage.getItem(storageKey) !== "false";
}

function availableAgentsSidebarWidth(): number {
  return Math.max(
    MIN_AGENTS_SIDEBAR_WIDTH,
    Math.min(MAX_AGENTS_SIDEBAR_WIDTH, window.innerWidth - 740),
  );
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
): "media" | "edit" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  if (event.key === "1") return "media";
  if (event.key === "2") return "edit";
  return null;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export function AppShell({
  session,
  appState,
  destination,
  projectSection,
  activeSequenceId,
  settingsSection,
  title,
  leadingToolbar,
  toolbar,
  onHome,
  onProjectSection,
  onTimeline,
  onSettings,
  onSettingsSection,
  onOpenRecent,
  onOpenProject,
  agentsSidebar,
  metricsSidebar,
  auxiliaryMode,
  onAuxiliaryMode,
  children,
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    initialSidebarOpen(SIDEBAR_OPEN_STORAGE_KEY),
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const sidebarWidthOptions = useMemo(
    () => ({
      storageKey: "cinesim.sidebarWidth",
      minimum: MIN_SIDEBAR_WIDTH,
      maximum: availableSidebarWidth,
      defaultWidth: DEFAULT_SIDEBAR_WIDTH,
      direction: 1 as const,
    }),
    [],
  );
  const auxiliaryWidthOptions = useMemo(
    () => ({
      storageKey: "cinesim.agentsSidebarWidth",
      minimum: MIN_AGENTS_SIDEBAR_WIDTH,
      maximum: availableAgentsSidebarWidth,
      defaultWidth: DEFAULT_AGENTS_SIDEBAR_WIDTH,
      direction: -1 as const,
    }),
    [],
  );
  const sidebarWidth = usePersistentSidebarWidth(sidebarWidthOptions);
  const auxiliaryWidth = usePersistentSidebarWidth(auxiliaryWidthOptions);
  const isMac = window.cinesim.platform === "darwin";
  const agentsSidebarAvailable = Boolean(agentsSidebar);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(sidebarOpen));
  }, [sidebarOpen]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const projectSection =
        destination === "project" && !isEditableShortcutTarget(event.target)
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
        setSidebarOpen((open) => !open);
      } else if (command && !event.altKey && event.shiftKey && key === "h") {
        event.preventDefault();
        setShortcutsOpen(false);
        onHome();
      } else if (command && !event.altKey && !event.shiftKey && key === "/") {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
      } else if (!command && !event.altKey && !event.shiftKey && key === "escape") {
        setShortcutsOpen(false);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [
    agentsSidebarAvailable,
    auxiliaryMode,
    destination,
    onAuxiliaryMode,
    onHome,
    onProjectSection,
  ]);

  return (
    <main className="flex h-screen overflow-hidden bg-canvas text-primary">
      <aside
        className={cn(
          "relative z-30 flex h-screen shrink-0 flex-col overflow-hidden border-r border-border bg-panel",
          !sidebarWidth.resizing && "transition-[width] duration-200 ease-in-out",
          !sidebarOpen && "border-r-transparent",
        )}
        style={{ width: sidebarOpen ? sidebarWidth.width : 0 }}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
      >
        <div className="app-drag h-12 shrink-0" />

        <div className="min-w-[220px] flex-1 overflow-y-auto p-2">
          {destination === "settings" ? (
            <nav className="space-y-1" aria-label="Settings sections">
              <SidebarButton active={false} onClick={onHome}>
                <House size={15} /> <span>Home</span>
                <span className="ml-auto">
                  <ShortcutHint>{isMac ? "⌘⇧H" : "Ctrl+⇧H"}</ShortcutHint>
                </span>
              </SidebarButton>
              <div className="my-2 h-px bg-border" />
              <p className="px-2.5 pb-2 pt-1 text-ui-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Settings
              </p>
              <SidebarButton
                active={settingsSection === "general"}
                onClick={() => onSettingsSection("general")}
              >
                <SlidersHorizontal size={15} /> General
              </SidebarButton>
              <SidebarButton
                active={settingsSection === "agents"}
                onClick={() => onSettingsSection("agents")}
              >
                <Bot size={15} /> Agents
              </SidebarButton>
            </nav>
          ) : (
            <>
              <nav className="space-y-1" aria-label="Application">
                <SidebarButton active={destination === "home"} onClick={onHome}>
                  <House size={15} /> <span>Home</span>
                  <span className="ml-auto">
                    <ShortcutHint>{isMac ? "⌘⇧H" : "Ctrl+⇧H"}</ShortcutHint>
                  </span>
                </SidebarButton>
              </nav>
              {destination === "project" && session && (
                <nav className="mt-3 space-y-1" aria-label="Project sections">
                  <p className="px-2.5 pb-1 pt-1 text-ui-xs font-semibold uppercase tracking-[0.12em] text-muted">
                    Project
                  </p>
                  <SidebarButton
                    active={projectSection === "media"}
                    onClick={() => onProjectSection("media")}
                  >
                    <Library size={15} /> Media
                    <span className="ml-auto">
                      <ShortcutHint>{isMac ? "⌘1" : "Ctrl+1"}</ShortcutHint>
                    </span>
                  </SidebarButton>
                  <SidebarButton
                    active={projectSection === "edit"}
                    onClick={() => onProjectSection("edit")}
                  >
                    <Scissors size={15} /> Edit
                    <span className="ml-auto">
                      <ShortcutHint>{isMac ? "⌘2" : "Ctrl+2"}</ShortcutHint>
                    </span>
                  </SidebarButton>
                </nav>
              )}
            </>
          )}
        </div>

        <div className="flex min-w-[220px] gap-1 p-2">
          <div className="min-w-0 flex-1">
            <SidebarButton active={destination === "settings"} onClick={onSettings}>
              <SettingsIcon size={15} /> Settings
            </SidebarButton>
          </div>
          <button
            className="grid size-9 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-primary"
            aria-label="Keyboard shortcuts"
            title={isMac ? "Keyboard shortcuts (⌘/)" : "Keyboard shortcuts (Ctrl+/)"}
            onClick={() => setShortcutsOpen(true)}
          >
            <Keyboard size={15} />
          </button>
        </div>

        <div
          className="no-drag absolute inset-y-0 right-[-3px] z-40 w-[6px] cursor-col-resize"
          {...sidebarWidth.resizeHandleProps}
        />
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="app-drag relative flex h-12 shrink-0 items-center justify-center border-b border-border bg-panel px-3">
          <button
            className={cn(
              "no-drag absolute top-2 grid size-8 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary",
              sidebarOpen ? "left-2" : isMac ? "left-[76px]" : "left-2",
            )}
            aria-label={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            title={`${sidebarOpen ? "Collapse" : "Open"} sidebar (${isMac ? "⌘B" : "Ctrl+B"})`}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}
          </button>
          {leadingToolbar && (
            <div
              className={cn(
                "no-drag absolute top-2",
                sidebarOpen ? "left-12" : isMac ? "left-[116px]" : "left-12",
              )}
            >
              {leadingToolbar}
            </div>
          )}
          {destination === "project" && session ? (
            <ProjectBreadcrumb
              session={session}
              recentProjects={appState.recentProjects}
              showTimeline={projectSection === "edit"}
              activeSequenceId={activeSequenceId ?? session.project.activeSequenceId}
              onOpenRecent={onOpenRecent}
              onOpenProject={onOpenProject}
              onTimeline={onTimeline}
            />
          ) : (
            <span className="max-w-[360px] truncate text-ui font-medium text-secondary">
              {title}
            </span>
          )}
          {toolbar && <div className="no-drag absolute right-3">{toolbar}</div>}
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>

      {(agentsSidebar || metricsSidebar) && (
        <aside
          className={cn(
            "relative z-30 flex h-screen shrink-0 flex-col overflow-hidden border-l border-border bg-panel",
            !auxiliaryWidth.resizing && "transition-[width] duration-200 ease-in-out",
            auxiliaryMode === null && "border-l-transparent",
          )}
          style={{ width: auxiliaryMode ? auxiliaryWidth.width : 0 }}
          aria-hidden={auxiliaryMode === null}
          inert={auxiliaryMode === null}
        >
          <div className="min-w-[260px] min-h-0 flex-1 overflow-y-auto">
            {auxiliaryMode === "metrics" ? metricsSidebar : agentsSidebar}
          </div>

          <div
            className="no-drag absolute inset-y-0 left-[-3px] z-40 w-[6px] cursor-col-resize"
            {...auxiliaryWidth.resizeHandleProps}
          />
        </aside>
      )}
      <ShortcutsDialog open={shortcutsOpen} isMac={isMac} onClose={() => setShortcutsOpen(false)} />
    </main>
  );
}

function SidebarButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-ui transition-colors",
        active ? "bg-surface text-primary" : "text-secondary hover:bg-surface hover:text-primary",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

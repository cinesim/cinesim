import { useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  FolderOpen,
  House,
  Keyboard,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@cinesim/ui";
import type { DesktopAppState, DesktopProjectSession } from "../../shared/api";
import { ShortcutHint, ShortcutsDialog } from "./shortcuts-dialog";

interface AppShellProps {
  session: DesktopProjectSession | null;
  appState: DesktopAppState;
  destination: "home" | "project" | "settings";
  title: string;
  toolbar: React.ReactNode;
  onHome: () => void;
  onProject: () => void;
  onSettings: () => void;
  onOpenRecent: (directory: string) => void;
  onOpenProject: () => void;
  agentsSidebar?: React.ReactNode;
  children: React.ReactNode;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_SIDEBAR_WIDTH = 272;
const MIN_AGENTS_SIDEBAR_WIDTH = 260;
const MAX_AGENTS_SIDEBAR_WIDTH = 420;
const DEFAULT_AGENTS_SIDEBAR_WIDTH = 320;
const SIDEBAR_OPEN_STORAGE_KEY = "cinesim.sidebarOpen";
const AGENTS_SIDEBAR_OPEN_STORAGE_KEY = "cinesim.agentsSidebarOpen";

function availableSidebarWidth(): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 740));
}

function initialSidebarWidth(): number {
  const rawStored = localStorage.getItem("cinesim.sidebarWidth");
  if (rawStored === null) return DEFAULT_SIDEBAR_WIDTH;
  const stored = Number(rawStored);
  return Number.isFinite(stored)
    ? Math.min(availableSidebarWidth(), Math.max(MIN_SIDEBAR_WIDTH, stored))
    : DEFAULT_SIDEBAR_WIDTH;
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

function initialAgentsSidebarWidth(): number {
  const rawStored = localStorage.getItem("cinesim.agentsSidebarWidth");
  if (rawStored === null) return DEFAULT_AGENTS_SIDEBAR_WIDTH;
  const stored = Number(rawStored);
  return Number.isFinite(stored)
    ? Math.min(availableAgentsSidebarWidth(), Math.max(MIN_AGENTS_SIDEBAR_WIDTH, stored))
    : DEFAULT_AGENTS_SIDEBAR_WIDTH;
}

export function isAgentsSidebarShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return (
    event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyB"
  );
}

export function AppShell({
  session,
  appState,
  destination,
  title,
  toolbar,
  onHome,
  onProject,
  onSettings,
  onOpenRecent,
  onOpenProject,
  agentsSidebar,
  children,
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    initialSidebarOpen(SIDEBAR_OPEN_STORAGE_KEY),
  );
  const [agentsSidebarOpen, setAgentsSidebarOpen] = useState(() =>
    initialSidebarOpen(AGENTS_SIDEBAR_OPEN_STORAGE_KEY),
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [agentsSidebarWidth, setAgentsSidebarWidth] = useState(initialAgentsSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [resizingAgentsSidebar, setResizingAgentsSidebar] = useState(false);
  const resizeOrigin = useRef({ x: 0, width: DEFAULT_SIDEBAR_WIDTH });
  const agentsResizeOrigin = useRef({ x: 0, width: DEFAULT_AGENTS_SIDEBAR_WIDTH });
  const isMac = window.cinesim.platform === "darwin";
  const agentsSidebarAvailable = Boolean(agentsSidebar);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(sidebarOpen));
  }, [sidebarOpen]);

  useEffect(() => {
    localStorage.setItem(AGENTS_SIDEBAR_OPEN_STORAGE_KEY, String(agentsSidebarOpen));
  }, [agentsSidebarOpen]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (isAgentsSidebarShortcut(event)) {
        if (agentsSidebarAvailable) {
          event.preventDefault();
          setAgentsSidebarOpen((open) => !open);
        }
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
  }, [agentsSidebarAvailable, onHome]);

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    resizeOrigin.current = { x: event.clientX, width: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }

  function resize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    const nextWidth = Math.min(
      availableSidebarWidth(),
      Math.max(
        MIN_SIDEBAR_WIDTH,
        resizeOrigin.current.width + event.clientX - resizeOrigin.current.x,
      ),
    );
    setSidebarWidth(nextWidth);
  }

  function finishResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    localStorage.setItem("cinesim.sidebarWidth", String(sidebarWidth));
    setResizing(false);
  }

  function startAgentsResize(event: React.PointerEvent<HTMLDivElement>) {
    agentsResizeOrigin.current = { x: event.clientX, width: agentsSidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingAgentsSidebar(true);
  }

  function resizeAgentsSidebar(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizingAgentsSidebar) return;
    const nextWidth = Math.min(
      availableAgentsSidebarWidth(),
      Math.max(
        MIN_AGENTS_SIDEBAR_WIDTH,
        agentsResizeOrigin.current.width + agentsResizeOrigin.current.x - event.clientX,
      ),
    );
    setAgentsSidebarWidth(nextWidth);
  }

  function finishAgentsResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizingAgentsSidebar) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    localStorage.setItem("cinesim.agentsSidebarWidth", String(agentsSidebarWidth));
    setResizingAgentsSidebar(false);
  }

  return (
    <main className="flex h-screen overflow-hidden bg-canvas text-primary">
      <aside
        className={cn(
          "relative z-30 flex h-screen shrink-0 flex-col overflow-hidden border-r border-border bg-panel",
          !resizing && "transition-[width] duration-200 ease-in-out",
          !sidebarOpen && "border-r-transparent",
        )}
        style={{ width: sidebarOpen ? sidebarWidth : 0 }}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
      >
        <div className="app-drag relative h-12 shrink-0">
          <button
            className={cn(
              "no-drag absolute right-2 top-2 grid size-8 place-items-center rounded-md text-muted transition-opacity hover:bg-surface hover:text-primary",
              sidebarOpen
                ? "delay-150 duration-75 opacity-100"
                : "pointer-events-none delay-0 duration-0 opacity-0",
            )}
            aria-label="Collapse sidebar"
            title={isMac ? "Collapse sidebar (⌘B)" : "Collapse sidebar (Ctrl+B)"}
            onClick={() => setSidebarOpen(false)}
          >
            <ChevronLeft size={17} />
          </button>
        </div>

        <div className="min-w-[220px] flex-1 overflow-y-auto p-2">
          <ProjectMenu
            session={session}
            recentProjects={appState.recentProjects}
            onProject={onProject}
            onOpenRecent={onOpenRecent}
            onOpenProject={onOpenProject}
          />
          <nav className="mt-3 space-y-1" aria-label="Application">
            <SidebarButton active={destination === "home"} onClick={onHome}>
              <House size={15} /> <span>Home</span>
              <span className="ml-auto">
                <ShortcutHint>{isMac ? "⌘⇧H" : "Ctrl+⇧H"}</ShortcutHint>
              </span>
            </SidebarButton>
          </nav>
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
          onPointerDown={startResize}
          onPointerMove={resize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
        />
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="app-drag relative flex h-12 shrink-0 items-center justify-center border-b border-border bg-panel px-3">
          {!sidebarOpen && (
            <button
              className={cn(
                "no-drag absolute top-2 grid size-8 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary",
                isMac ? "left-[76px]" : "left-2",
              )}
              aria-label="Open sidebar"
              title={isMac ? "Open sidebar (⌘B)" : "Open sidebar (Ctrl+B)"}
              onClick={() => setSidebarOpen(true)}
            >
              <ChevronRight size={17} />
            </button>
          )}
          <span className="max-w-[360px] truncate text-ui font-medium text-secondary">{title}</span>
          {toolbar && (
            <div
              className={cn(
                "no-drag absolute transition-[right] duration-200 ease-in-out",
                agentsSidebar && !agentsSidebarOpen ? "right-12" : "right-3",
              )}
            >
              {toolbar}
            </div>
          )}
          {agentsSidebar && !agentsSidebarOpen && (
            <button
              className="no-drag absolute right-2 top-2 grid size-8 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary"
              aria-label="Open agents sidebar"
              title="Open agents sidebar (⌥⌘B)"
              onClick={() => setAgentsSidebarOpen(true)}
            >
              <ChevronLeft size={17} />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>

      {agentsSidebar && (
        <aside
          className={cn(
            "relative z-30 flex h-screen shrink-0 flex-col overflow-hidden border-l border-border bg-panel",
            !resizingAgentsSidebar && "transition-[width] duration-200 ease-in-out",
            !agentsSidebarOpen && "border-l-transparent",
          )}
          style={{ width: agentsSidebarOpen ? agentsSidebarWidth : 0 }}
          aria-hidden={!agentsSidebarOpen}
          inert={!agentsSidebarOpen}
        >
          <div className="app-drag relative flex h-12 min-w-[260px] shrink-0 items-center justify-center border-b border-border">
            <button
              className={cn(
                "no-drag absolute left-2 top-2 grid size-8 place-items-center rounded-md text-muted transition-opacity hover:bg-surface hover:text-primary",
                agentsSidebarOpen
                  ? "delay-150 duration-75 opacity-100"
                  : "pointer-events-none delay-0 duration-0 opacity-0",
              )}
              aria-label="Collapse agents sidebar"
              title="Collapse agents sidebar (⌥⌘B)"
              onClick={() => setAgentsSidebarOpen(false)}
            >
              <ChevronRight size={17} />
            </button>
            <span className="flex items-center gap-1.5 text-ui font-medium text-secondary">
              <Bot size={15} /> Agents
            </span>
          </div>

          <div className="min-w-[260px] min-h-0 flex-1 overflow-y-auto">{agentsSidebar}</div>

          <div
            className="no-drag absolute inset-y-0 left-[-3px] z-40 w-[6px] cursor-col-resize"
            onPointerDown={startAgentsResize}
            onPointerMove={resizeAgentsSidebar}
            onPointerUp={finishAgentsResize}
            onPointerCancel={finishAgentsResize}
          />
        </aside>
      )}
      <ShortcutsDialog open={shortcutsOpen} isMac={isMac} onClose={() => setShortcutsOpen(false)} />
    </main>
  );
}

function ProjectMenu({
  session,
  recentProjects,
  onProject,
  onOpenRecent,
  onOpenProject,
}: {
  session: DesktopProjectSession | null;
  recentProjects: DesktopAppState["recentProjects"];
  onProject: () => void;
  onOpenRecent: (directory: string) => void;
  onOpenProject: () => void;
}) {
  return (
    <details className="sidebar-project-menu relative">
      <summary className="flex h-10 list-none items-center gap-2 rounded-lg border border-border bg-panel-muted px-2.5 outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-on-accent">
          <Clapperboard size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-ui font-medium">
          {session?.project.name ?? "Choose a project"}
        </span>
        <ChevronDown size={13} className="text-muted" />
      </summary>
      <div className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-lg border border-border bg-panel p-1 shadow-xl shadow-black/15">
        {session && (
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui hover:bg-surface"
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              onProject();
            }}
          >
            <Clapperboard size={14} className="text-muted" />
            <span className="min-w-0 flex-1 truncate">{session.project.name}</span>
          </button>
        )}
        {recentProjects
          .filter((project) => project.directory !== session?.directory)
          .slice(0, 6)
          .map((project) => (
            <button
              key={project.directory}
              className="block w-full rounded-md px-2 py-2 text-left hover:bg-surface"
              title={project.directory}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                onOpenRecent(project.directory);
              }}
            >
              <span className="block truncate text-ui text-primary">{project.name}</span>
              <span className="block truncate text-ui-xs text-muted">{project.directory}</span>
            </button>
          ))}
        {recentProjects.length === 0 && !session && (
          <p className="px-2 py-3 text-ui-xs text-muted">Recent projects will appear here.</p>
        )}
        <div className="my-1 h-px bg-border" />
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui text-secondary hover:bg-surface hover:text-primary"
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            onOpenProject();
          }}
        >
          <FolderOpen size={14} /> Open another project…
        </button>
      </div>
    </details>
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

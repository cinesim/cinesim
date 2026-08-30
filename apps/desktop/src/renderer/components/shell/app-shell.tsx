import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Keyboard, Settings as SettingsIcon } from "@cinesim/ui";
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from "@cinesim/ui";
import type { AccountSnapshot, DesktopAppState, DesktopProjectSession } from "../../../shared/api";
import { usePersistentSidebarWidth } from "../../hooks/use-persistent-sidebar-width";
import { useShellShortcuts } from "../../hooks/use-shell-shortcuts";
import type {
  AuxiliarySidebarMode,
  Destination,
  ProjectSection,
  SettingsSection,
} from "../../store/renderer-store";
import { AccountMenu } from "./account-menu";
import type { AccountActionResult } from "./account-menu";
import { AppSidebarNavigation } from "./app-sidebar";
import { ProjectBreadcrumb } from "./project-breadcrumb";
import { ShortcutsDialog } from "./shortcuts-dialog";

interface AppShellProps {
  session: DesktopProjectSession | null;
  appState: DesktopAppState;
  destination: Destination;
  projectSection: ProjectSection;
  activeSequenceId: string | null;
  settingsSection: SettingsSection;
  account: AccountSnapshot;
  accountHydrated: boolean;
  interactionLocked: boolean;
  title: string;
  leadingToolbar?: React.ReactNode;
  toolbar: React.ReactNode;
  onHome: () => void;
  onProjectSection: (section: ProjectSection) => void;
  onTimeline: (sequenceId: string) => void;
  onSettings: () => void;
  onSettingsSection: (section: SettingsSection) => void;
  onAccountSignIn: (method: "email" | "google") => Promise<AccountActionResult>;
  onAccountSignOut: () => Promise<AccountActionResult>;
  onOpenRecent: (directory: string) => void;
  onOpenProject: () => void;
  agentsSidebar?: React.ReactNode;
  metricsSidebar?: React.ReactNode;
  auxiliaryMode: AuxiliarySidebarMode;
  onAuxiliaryMode: (mode: AuxiliarySidebarMode) => void;
  children: React.ReactNode;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_SIDEBAR_WIDTH = 272;
const MIN_AUXILIARY_WIDTH = 260;
const MAX_AUXILIARY_WIDTH = 420;
const DEFAULT_AUXILIARY_WIDTH = 320;
const SIDEBAR_OPEN_STORAGE_KEY = "cinesim.sidebarOpen";

function availableSidebarWidth(): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 740));
}

function availableAuxiliaryWidth(): number {
  return Math.max(MIN_AUXILIARY_WIDTH, Math.min(MAX_AUXILIARY_WIDTH, window.innerWidth - 740));
}

export function AppShell({
  session,
  appState,
  destination,
  projectSection,
  activeSequenceId,
  settingsSection,
  account,
  accountHydrated,
  interactionLocked,
  title,
  leadingToolbar,
  toolbar,
  onHome,
  onProjectSection,
  onTimeline,
  onSettings,
  onSettingsSection,
  onAccountSignIn,
  onAccountSignOut,
  onOpenRecent,
  onOpenProject,
  agentsSidebar,
  metricsSidebar,
  auxiliaryMode,
  onAuxiliaryMode,
  children,
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== "false",
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
      minimum: MIN_AUXILIARY_WIDTH,
      maximum: availableAuxiliaryWidth,
      defaultWidth: DEFAULT_AUXILIARY_WIDTH,
      direction: -1 as const,
    }),
    [],
  );
  const sidebarWidth = usePersistentSidebarWidth(sidebarWidthOptions);
  const auxiliaryWidth = usePersistentSidebarWidth(auxiliaryWidthOptions);
  const isMac = window.cinesim.platform === "darwin";
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const toggleShortcuts = useCallback(() => setShortcutsOpen((open) => !open), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  useShellShortcuts({
    destination,
    agentsSidebarAvailable: Boolean(agentsSidebar),
    auxiliaryMode,
    onAuxiliaryMode,
    onHome,
    onProjectSection,
    onToggleSidebar: toggleSidebar,
    onToggleShortcuts: toggleShortcuts,
    onCloseShortcuts: closeShortcuts,
  });

  useEffect(() => {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(sidebarOpen));
  }, [sidebarOpen]);

  return (
    <main
      className="flex h-screen overflow-hidden bg-canvas text-primary"
      inert={interactionLocked || undefined}
    >
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
          <AppSidebarNavigation
            destination={destination}
            projectAvailable={session !== null}
            projectSection={projectSection}
            settingsSection={settingsSection}
            account={account}
            isMac={isMac}
            onHome={onHome}
            onProjectSection={onProjectSection}
            onSettingsSection={onSettingsSection}
          />
        </div>

        <div className="flex min-w-[220px] items-center gap-1 p-2">
          <AccountMenu
            account={account}
            hydrated={accountHydrated}
            width={sidebarWidth.width}
            onSignIn={onAccountSignIn}
            onSignOut={onAccountSignOut}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  className="shrink-0"
                  size="icon-lg"
                  variant="ghost"
                  aria-label="Keyboard shortcuts"
                  onClick={() => setShortcutsOpen(true)}
                />
              }
            >
              <Keyboard size={15} />
            </TooltipTrigger>
            <TooltipContent>Keyboard shortcuts ({isMac ? "⌘/" : "Ctrl+/"})</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  className="shrink-0"
                  size="icon-lg"
                  variant={destination === "settings" ? "secondary" : "ghost"}
                  aria-label="Settings"
                  onClick={onSettings}
                />
              }
            >
              <SettingsIcon size={15} />
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>

        <div
          className="no-drag absolute inset-y-0 right-[-3px] z-40 w-[6px] cursor-col-resize"
          {...sidebarWidth.resizeHandleProps}
        />
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="app-drag relative flex h-12 shrink-0 items-center justify-center border-b border-border bg-panel px-3">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  className={cn(
                    "no-drag absolute top-2",
                    sidebarOpen ? "left-2" : isMac ? "left-[76px]" : "left-2",
                  )}
                  size="icon"
                  variant="ghost"
                  aria-label={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
                  onClick={toggleSidebar}
                />
              }
            >
              {sidebarOpen ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}
            </TooltipTrigger>
            <TooltipContent>
              {sidebarOpen ? "Collapse" : "Open"} sidebar ({isMac ? "⌘B" : "Ctrl+B"})
            </TooltipContent>
          </Tooltip>
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
              showTimeline={projectSection === "cut" || projectSection === "edit"}
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
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
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
            <div className={cn("h-full", auxiliaryMode === "metrics" && "hidden")}>
              {agentsSidebar}
            </div>
            {auxiliaryMode === "metrics" && metricsSidebar}
          </div>
          <div
            className="no-drag absolute inset-y-0 left-[-3px] z-40 w-[6px] cursor-col-resize"
            {...auxiliaryWidth.resizeHandleProps}
          />
        </aside>
      )}
      <ShortcutsDialog open={shortcutsOpen} isMac={isMac} onClose={closeShortcuts} />
    </main>
  );
}

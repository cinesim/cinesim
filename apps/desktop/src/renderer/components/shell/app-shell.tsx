import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  AudioLines,
  Cloud,
  ChevronLeft,
  ChevronRight,
  House,
  Keyboard,
  Library,
  LoaderCircle,
  LogOut,
  Scissors,
  SlidersHorizontal,
  Film,
  Settings as SettingsIcon,
  User,
} from "@cinesim/ui";
import {
  Button,
  cn,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cinesim/ui";
import type { AccountSnapshot, DesktopAppState, DesktopProjectSession } from "../../../shared/api";
import type { SettingsSection } from "../../store/renderer-store";
import { usePersistentSidebarWidth } from "../../hooks/use-persistent-sidebar-width";
import { AccountAvatar, accountDisplayName, GoogleMark } from "../account/account-ui";
import { ProjectBreadcrumb } from "./project-breadcrumb";
import { ShortcutHint, ShortcutsDialog } from "./shortcuts-dialog";

interface AppShellProps {
  session: DesktopProjectSession | null;
  appState: DesktopAppState;
  destination: "home" | "project" | "settings";
  projectSection: "media" | "cut" | "edit";
  activeSequenceId: string | null;
  settingsSection: SettingsSection;
  account: AccountSnapshot;
  accountHydrated: boolean;
  interactionLocked: boolean;
  title: string;
  leadingToolbar?: React.ReactNode;
  toolbar: React.ReactNode;
  onHome: () => void;
  onProjectSection: (section: "media" | "cut" | "edit") => void;
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

export type AuxiliarySidebarMode = "agents" | "metrics" | null;
type AccountActionResult = { ok: true } | { ok: false; error: string };

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
): "media" | "cut" | "edit" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  if (event.key === "1") return "media";
  if (event.key === "2") return "cut";
  if (event.key === "3") return "edit";
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
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    initialSidebarOpen(SIDEBAR_OPEN_STORAGE_KEY),
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState<"email" | "google" | "sign-out" | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
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

  async function startAccountSignIn(method: "email" | "google"): Promise<void> {
    setAccountBusy(method);
    setAccountMessage(null);
    const result = await onAccountSignIn(method);
    setAccountBusy(null);
    if (result.ok) setAccountMenuOpen(false);
    else setAccountMessage(result.error);
  }

  async function signOutAccount(): Promise<void> {
    setAccountBusy("sign-out");
    setAccountMessage(null);
    const result = await onAccountSignOut();
    setAccountBusy(null);
    if (result.ok) setAccountMenuOpen(false);
    else setAccountMessage(result.error);
  }

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
          {destination === "settings" ? (
            <nav className="space-y-1" aria-label="Settings sections">
              <SidebarButton active={false} onClick={onHome}>
                <House size={15} /> <span>Home</span>
                <span className="ml-auto">
                  <ShortcutHint>{isMac ? "⌘⇧H" : "Ctrl+⇧H"}</ShortcutHint>
                </span>
              </SidebarButton>
              <Separator className="my-2" />
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
                active={settingsSection === "account"}
                onClick={() => onSettingsSection("account")}
              >
                <User size={15} /> Account
              </SidebarButton>
              <SidebarButton
                active={settingsSection === "media"}
                onClick={() => onSettingsSection("media")}
              >
                <Film size={15} /> Media & proxies
              </SidebarButton>
              <SidebarButton
                active={settingsSection === "transcription"}
                onClick={() => onSettingsSection("transcription")}
              >
                <AudioLines size={15} /> Transcription
              </SidebarButton>
              {account.status === "signed-in" && account.cloudStorage === true && (
                <SidebarButton
                  active={settingsSection === "storage"}
                  onClick={() => onSettingsSection("storage")}
                >
                  <Cloud size={15} /> Cloud storage
                </SidebarButton>
              )}
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
                    active={projectSection === "cut"}
                    onClick={() => onProjectSection("cut")}
                  >
                    <Scissors size={15} /> Cut
                    <span className="ml-auto">
                      <ShortcutHint>{isMac ? "⌘2" : "Ctrl+2"}</ShortcutHint>
                    </span>
                  </SidebarButton>
                  <SidebarButton
                    active={projectSection === "edit"}
                    onClick={() => onProjectSection("edit")}
                  >
                    <Film size={15} /> Edit
                    <span className="ml-auto">
                      <ShortcutHint>{isMac ? "⌘3" : "Ctrl+3"}</ShortcutHint>
                    </span>
                  </SidebarButton>
                </nav>
              )}
            </>
          )}
        </div>

        <div className="flex min-w-[220px] items-center gap-1 p-2">
          <Menu
            open={accountMenuOpen}
            onOpenChange={(open) => {
              setAccountMenuOpen(open);
              if (!open) setAccountMessage(null);
            }}
          >
            <MenuTrigger
              className={cn(
                "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left text-ui text-secondary transition-colors hover:bg-surface hover:text-primary",
                accountMenuOpen && "bg-surface text-primary",
              )}
              aria-label="Account menu"
            >
              <AccountAvatar user={accountHydrated ? account.user : null} />
              <span className="min-w-0 flex-1 truncate">
                {accountHydrated ? accountDisplayName(account) : "Account"}
              </span>
              {accountHydrated && account.status === "offline" && account.user && (
                <span className="shrink-0 text-ui-xs text-amber-500">Offline</span>
              )}
            </MenuTrigger>
            <MenuContent
              side="top"
              align="start"
              sideOffset={8}
              className="p-2"
              style={{ width: sidebarWidth.width - 16 }}
            >
              {!accountHydrated ? (
                <div className="flex items-center gap-3 px-2 py-2" aria-busy="true">
                  <AccountAvatar user={null} size="md" />
                  <p className="text-ui text-muted">Checking account…</p>
                </div>
              ) : account.status === "signed-in" && account.user ? (
                <div className="flex items-center gap-3 px-2 py-2">
                  <AccountAvatar user={account.user} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ui font-semibold text-primary">
                      {account.user.name}
                    </p>
                    <p className="truncate text-ui-xs text-muted">{account.user.email}</p>
                  </div>
                  <MenuItem
                    aria-label={accountBusy === "sign-out" ? "Signing out" : "Sign out"}
                    title={accountBusy === "sign-out" ? "Signing out…" : "Sign out"}
                    className="ml-auto size-8 min-h-0 shrink-0 justify-center p-0 text-muted"
                    disabled={accountBusy !== null}
                    onClick={() => void signOutAccount()}
                  >
                    {accountBusy === "sign-out" ? (
                      <LoaderCircle className="animate-spin" size={15} />
                    ) : (
                      <LogOut size={15} />
                    )}
                  </MenuItem>
                </div>
              ) : (
                <>
                  <div className="px-2 py-2">
                    <p className="text-ui font-semibold text-primary">Local workspace</p>
                  </div>
                  <div className="space-y-2 px-1 pb-1">
                    <Button
                      className="w-full"
                      variant="primary"
                      disabled={!account.googleSignIn || accountBusy !== null}
                      onClick={() => void startAccountSignIn("google")}
                    >
                      <GoogleMark className="size-4" />
                      {accountBusy === "google" ? "Opening Google…" : "Continue with Google"}
                    </Button>
                    <Button
                      className="w-full"
                      variant="secondary"
                      disabled={!account.serviceAvailable || accountBusy !== null}
                      onClick={() => void startAccountSignIn("email")}
                    >
                      {accountBusy === "email" ? "Opening browser…" : "Sign in with email"}
                    </Button>
                  </div>
                  {accountMessage && (
                    <p className="px-2 pt-2 text-ui-xs leading-5 text-red-400">{accountMessage}</p>
                  )}
                  {!account.serviceAvailable && !accountMessage && (
                    <p className="px-2 pt-2 text-ui-xs leading-5 text-amber-500">
                      {account.detail ?? "The account service is unavailable."}
                    </p>
                  )}
                </>
              )}
            </MenuContent>
          </Menu>
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
                  onClick={() => setSidebarOpen((open) => !open)}
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

import {
  AudioLines,
  Bot,
  Cloud,
  Film,
  House,
  Library,
  Scissors,
  SlidersHorizontal,
  User,
} from "@cinesim/ui";
import { cn, Separator } from "@cinesim/ui";
import type { AccountSnapshot } from "../../../shared/api";
import type { Destination, ProjectSection, SettingsSection } from "../../store/renderer-store";
import { ShortcutHint } from "./shortcuts-dialog";

const SETTINGS_ITEMS = [
  { section: "general", label: "General", icon: SlidersHorizontal },
  { section: "account", label: "Account", icon: User },
  { section: "media", label: "Media & proxies", icon: Film },
  { section: "transcription", label: "Transcription", icon: AudioLines },
  { section: "storage", label: "Cloud storage", icon: Cloud },
  { section: "agents", label: "Agents", icon: Bot },
] as const;

const PROJECT_ITEMS = [
  { section: "media", label: "Media", icon: Library, shortcut: "1" },
  { section: "cut", label: "Cut", icon: Scissors, shortcut: "2" },
  { section: "edit", label: "Edit", icon: Film, shortcut: "3" },
] as const;

interface AppSidebarNavigationProps {
  destination: Destination;
  projectAvailable: boolean;
  projectSection: ProjectSection;
  settingsSection: SettingsSection;
  account: AccountSnapshot;
  isMac: boolean;
  onHome: () => void;
  onProjectSection: (section: ProjectSection) => void;
  onSettingsSection: (section: SettingsSection) => void;
}

export function AppSidebarNavigation({
  destination,
  projectAvailable,
  projectSection,
  settingsSection,
  account,
  isMac,
  onHome,
  onProjectSection,
  onSettingsSection,
}: AppSidebarNavigationProps) {
  if (destination === "settings")
    return (
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
        {SETTINGS_ITEMS.map((item) => {
          if (
            item.section === "storage" &&
            (account.status !== "signed-in" || account.cloudStorage !== true)
          )
            return null;
          const Icon = item.icon;
          return (
            <SidebarButton
              key={item.section}
              active={settingsSection === item.section}
              onClick={() => onSettingsSection(item.section)}
            >
              <Icon size={15} /> {item.label}
            </SidebarButton>
          );
        })}
      </nav>
    );

  return (
    <>
      <nav className="space-y-1" aria-label="Application">
        <SidebarButton active={destination === "home"} onClick={onHome}>
          <House size={15} /> <span>Home</span>
          <span className="ml-auto">
            <ShortcutHint>{isMac ? "⌘⇧H" : "Ctrl+⇧H"}</ShortcutHint>
          </span>
        </SidebarButton>
      </nav>
      {destination === "project" && projectAvailable && (
        <nav className="mt-3 space-y-1" aria-label="Project sections">
          <p className="px-2.5 pb-1 pt-1 text-ui-xs font-semibold uppercase tracking-[0.12em] text-muted">
            Project
          </p>
          {PROJECT_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <SidebarButton
                key={item.section}
                active={projectSection === item.section}
                onClick={() => onProjectSection(item.section)}
              >
                <Icon size={15} /> {item.label}
                <span className="ml-auto">
                  <ShortcutHint>
                    {isMac ? `⌘${item.shortcut}` : `Ctrl+${item.shortcut}`}
                  </ShortcutHint>
                </span>
              </SidebarButton>
            );
          })}
        </nav>
      )}
    </>
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

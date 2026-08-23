import { Check, ChevronRight, Clapperboard, Film, FolderOpen } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@cinesim/ui";
import { sequenceDurationUs } from "@cinesim/core";
import type { DesktopAppState, DesktopProjectSession } from "../../shared/api";
import { formatDuration } from "../lib/format";

interface ProjectBreadcrumbProps {
  session: DesktopProjectSession;
  recentProjects: DesktopAppState["recentProjects"];
  showTimeline: boolean;
  activeSequenceId: string;
  onOpenRecent: (directory: string) => void;
  onOpenProject: () => void;
  onTimeline: (sequenceId: string) => void;
}

const triggerClassName =
  "flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium text-secondary outline-none transition-colors hover:bg-surface hover:text-primary focus-visible:ring-2 focus-visible:ring-focus data-[popup-open]:bg-surface data-[popup-open]:text-primary";

const positionerClassName = "z-[80] outline-none";

const popupClassName =
  "origin-[var(--transform-origin)] overflow-hidden rounded-xl border border-border-strong bg-panel p-1.5 text-primary shadow-2xl shadow-black/30 outline-none transition-[transform,opacity] duration-100 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

const itemClassName =
  "group flex min-h-10 cursor-default items-center gap-2 rounded-lg px-2.5 text-left outline-none data-[highlighted]:bg-surface";

export function ProjectBreadcrumb({
  session,
  recentProjects,
  showTimeline,
  activeSequenceId,
  onOpenRecent,
  onOpenProject,
  onTimeline,
}: ProjectBreadcrumbProps) {
  const activeSequence =
    session.project.sequences.find((sequence) => sequence.id === activeSequenceId) ??
    session.project.sequences.find((sequence) => sequence.id === session.project.activeSequenceId);

  return (
    <nav className="no-drag flex min-w-0 items-center" aria-label="Project location">
      <Menu.Root>
        <Menu.Trigger className={triggerClassName} aria-label="Choose project">
          <Clapperboard size={13} className="shrink-0 text-muted" />
          <span className="max-w-44 truncate">{session.project.name}</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className={positionerClassName} sideOffset={7} align="start">
            <Menu.Popup className={cn(popupClassName, "w-72")}>
              <Menu.Item className={itemClassName}>
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-on-accent">
                  <Clapperboard size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">{session.project.name}</span>
                  <span className="block truncate text-ui-xs text-muted">Current project</span>
                </span>
                <Check size={14} className="shrink-0 text-accent" />
              </Menu.Item>
              {recentProjects
                .filter((project) => project.directory !== session.directory)
                .slice(0, 8)
                .map((project) => (
                  <Menu.Item
                    key={project.directory}
                    className={itemClassName}
                    onClick={() => onOpenRecent(project.directory)}
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-panel-muted text-muted">
                      <Clapperboard size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui font-medium">{project.name}</span>
                      <span className="block truncate text-ui-xs text-muted">
                        {project.directory}
                      </span>
                    </span>
                  </Menu.Item>
                ))}
              <Menu.Separator className="my-1.5 h-px bg-border" />
              <Menu.Item className={itemClassName} onClick={onOpenProject}>
                <FolderOpen size={14} className="ml-1 shrink-0 text-muted" />
                <span className="text-ui text-secondary group-data-[highlighted]:text-primary">
                  Open another project…
                </span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      {showTimeline && activeSequence && (
        <>
          <ChevronRight size={13} className="mx-0.5 shrink-0 text-disabled" />
          <Menu.Root>
            <Menu.Trigger className={triggerClassName} aria-label="Choose timeline">
              <Film size={13} className="shrink-0 text-muted" />
              <span className="max-w-52 truncate">{activeSequence.name}</span>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className={positionerClassName} sideOffset={7} align="start">
                <Menu.Popup className={cn(popupClassName, "w-72")}>
                  {session.project.sequences.map((sequence) => {
                    const active = sequence.id === activeSequence.id;
                    return (
                      <Menu.Item
                        key={sequence.id}
                        className={itemClassName}
                        onClick={() => onTimeline(sequence.id)}
                      >
                        <span
                          className={cn(
                            "grid size-7 shrink-0 place-items-center rounded-md",
                            active ? "bg-accent text-on-accent" : "bg-panel-muted text-muted",
                          )}
                        >
                          <Film size={13} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-ui font-medium">
                            {sequence.name}
                          </span>
                          <span className="block text-ui-xs text-muted tabular-nums">
                            {formatDuration(sequenceDurationUs(sequence))} · {sequence.frameRate}{" "}
                            fps
                          </span>
                        </span>
                        {active && <Check size={14} className="shrink-0 text-accent" />}
                      </Menu.Item>
                    );
                  })}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </>
      )}
    </nav>
  );
}

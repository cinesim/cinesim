import { Check, ChevronRight, Clapperboard, Film, FolderOpen } from "lucide-react";
import { cn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@cinesim/ui";
import { sequenceDurationUs } from "@cinesim/core";
import type { DesktopAppState, DesktopProjectSession } from "../../../shared/api";
import { formatDuration } from "../../lib/format";

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
      <Menu>
        <MenuTrigger className={triggerClassName} aria-label="Choose project">
          <Clapperboard size={13} className="shrink-0 text-muted" />
          <span className="max-w-44 truncate">{session.project.name}</span>
        </MenuTrigger>
        <MenuContent className="w-72" sideOffset={7}>
          <MenuItem>
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-on-accent">
              <Clapperboard size={13} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium">{session.project.name}</span>
              <span className="block truncate text-ui-xs text-muted">Current project</span>
            </span>
            <Check size={14} className="shrink-0 text-accent" />
          </MenuItem>
          {recentProjects
            .filter((project) => project.directory !== session.directory)
            .slice(0, 8)
            .map((project) => (
              <MenuItem key={project.directory} onClick={() => onOpenRecent(project.directory)}>
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-panel-muted text-muted">
                  <Clapperboard size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">{project.name}</span>
                  <span className="block truncate text-ui-xs text-muted">{project.directory}</span>
                </span>
              </MenuItem>
            ))}
          <MenuSeparator />
          <MenuItem onClick={onOpenProject}>
            <FolderOpen size={14} className="ml-1 shrink-0 text-muted" />
            <span className="text-ui text-secondary group-data-[highlighted]:text-primary">
              Open another project…
            </span>
          </MenuItem>
        </MenuContent>
      </Menu>

      {showTimeline && activeSequence && (
        <>
          <ChevronRight size={13} className="mx-0.5 shrink-0 text-disabled" />
          <Menu>
            <MenuTrigger className={triggerClassName} aria-label="Choose timeline">
              <Film size={13} className="shrink-0 text-muted" />
              <span className="max-w-52 truncate">{activeSequence.name}</span>
            </MenuTrigger>
            <MenuContent className="w-72" sideOffset={7}>
              {session.project.sequences.map((sequence) => {
                const active = sequence.id === activeSequence.id;
                return (
                  <MenuItem key={sequence.id} onClick={() => onTimeline(sequence.id)}>
                    <span
                      className={cn(
                        "grid size-7 shrink-0 place-items-center rounded-md",
                        active ? "bg-accent text-on-accent" : "bg-panel-muted text-muted",
                      )}
                    >
                      <Film size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui font-medium">{sequence.name}</span>
                      <span className="block text-ui-xs text-muted tabular-nums">
                        {formatDuration(sequenceDurationUs(sequence))} · {sequence.frameRate} fps
                      </span>
                    </span>
                    {active && <Check size={14} className="shrink-0 text-accent" />}
                  </MenuItem>
                );
              })}
            </MenuContent>
          </Menu>
        </>
      )}
    </nav>
  );
}

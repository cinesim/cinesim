import { Check, ChevronRight } from "@cinesim/ui";
import { cn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@cinesim/ui";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";

const triggerClassName =
  "flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium text-secondary outline-none transition-colors hover:bg-surface hover:text-primary focus-visible:ring-2 focus-visible:ring-focus data-[popup-open]:bg-surface data-[popup-open]:text-primary";

export function ProjectBreadcrumb() {
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const recentProjects = useRendererStore((state) => state.appState.recentProjects);
  const projectSection = useRendererStore((state) => state.projectSection);
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const openRecentProject = useRendererStore((state) => state.openRecentProject);
  const openProject = useRendererStore((state) => state.openProject);
  const showTimeline = useRendererStore((state) => state.showTimeline);
  if (!session) return null;
  const activeSequence =
    session.project.sequences.find((sequence) => sequence.id === activeSequenceId) ??
    session.project.sequences.find((sequence) => sequence.id === session.project.activeSequenceId);
  const timelineVisible =
    projectSection === "cut" || projectSection === "edit" || projectSection === "effects";
  const switchableProjects = recentProjects
    .filter((project) => project.directory !== session.directory)
    .slice(0, 8);

  return (
    <nav className="no-drag flex min-w-0 items-center" aria-label="Project location">
      <Menu>
        <MenuTrigger className={triggerClassName} aria-label="Choose project">
          <span className="max-w-44 truncate">{session.project.name}</span>
        </MenuTrigger>
        <MenuContent className="w-72" sideOffset={7}>
          <MenuItem>
            <span className="min-w-0 flex-1 truncate text-ui font-medium">
              {session.project.name}
            </span>
          </MenuItem>
          {switchableProjects.map((project) => (
            <MenuItem
              key={project.directory}
              onClick={() => void openRecentProject(project.directory)}
            >
              <span className="min-w-0 flex-1 truncate text-ui font-medium">{project.name}</span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => void openProject()}>
            <span className="text-ui text-secondary group-data-[highlighted]:text-primary">
              Open another project…
            </span>
          </MenuItem>
        </MenuContent>
      </Menu>

      {activeSequence && (
        <div
          className={cn(
            "grid transition-[grid-template-columns,opacity] duration-150 ease-in-out motion-reduce:transition-none",
            timelineVisible ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0",
          )}
          aria-hidden={!timelineVisible}
          inert={!timelineVisible || undefined}
        >
          <div className="min-w-0 overflow-hidden">
            <div className="flex min-w-max items-center">
              <ChevronRight size={13} className="mx-0.5 shrink-0 text-disabled" />
              <Menu>
                <MenuTrigger className={triggerClassName} aria-label="Choose timeline">
                  <span key={activeSequence.id} className="header-timeline-label max-w-52 truncate">
                    {activeSequence.name}
                  </span>
                </MenuTrigger>
                <MenuContent className="w-80" sideOffset={7}>
                  {session.project.sequences.map((sequence) => {
                    const active = sequence.id === activeSequence.id;
                    return (
                      <MenuItem key={sequence.id} onClick={() => showTimeline(sequence.id)}>
                        <span className="min-w-0 flex-1 truncate text-ui font-medium">
                          {sequence.name}
                        </span>
                        <span className="shrink-0 text-right text-ui-xs text-muted tabular-nums">
                          {sequence.width} × {sequence.height} ·{" "}
                          {Number(sequence.frameRate.toFixed(2))} fps
                        </span>
                        <span className="grid size-4 shrink-0 place-items-center">
                          {active && <Check size={14} className="text-accent" />}
                        </span>
                      </MenuItem>
                    );
                  })}
                </MenuContent>
              </Menu>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

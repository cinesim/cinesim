import { useEffect, useState } from "react";
import {
  BrandVscode,
  Button,
  Check,
  ChevronDown,
  cn,
  FilePenLine,
  FolderOpen,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Terminal,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cinesim/ui";
import type { ProjectOpenTarget, ProjectOpenTargetId } from "../../../shared/contracts";
import { PROJECT_OPEN_TARGET_IDS } from "../../../shared/contracts";
import { useRendererStore } from "../../store/renderer-store-context";

const OPEN_TARGET_STORAGE_KEY = "cinesim.projectOpenTarget";
const FINDER_TARGET: ProjectOpenTarget = {
  id: "finder",
  label: "Finder",
  kind: "file-manager",
};

function storedTarget(): ProjectOpenTargetId {
  const stored = localStorage.getItem(OPEN_TARGET_STORAGE_KEY);
  return PROJECT_OPEN_TARGET_IDS.find((target) => target === stored) ?? "finder";
}

function rememberTarget(target: ProjectOpenTargetId): void {
  localStorage.setItem(OPEN_TARGET_STORAGE_KEY, target);
}

function targetIcon(target: ProjectOpenTarget, className?: string) {
  if (target.id === "vscode") return <BrandVscode className={cn("text-[#23a8f2]", className)} />;
  if (target.id === "cursor") return <TargetMonogram className={className}>C</TargetMonogram>;
  if (target.id === "zed") return <TargetMonogram className={className}>Z</TargetMonogram>;
  if (target.id === "ghostty") return <Terminal className={cn("text-violet-400", className)} />;
  if (target.kind === "terminal") return <Terminal className={className} />;
  if (target.kind === "editor") return <FilePenLine className={className} />;
  return <FolderOpen className={className} />;
}

function TargetMonogram({
  children,
  className,
}: {
  children: string;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-[3px] bg-primary text-[9px] font-bold leading-none text-canvas",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ProjectOpenButton() {
  const reportError = useRendererStore((state) => state.reportError);
  const [targets, setTargets] = useState<ProjectOpenTarget[]>([FINDER_TARGET]);
  const [selectedId, setSelectedId] = useState<ProjectOpenTargetId>(storedTarget);
  const [busy, setBusy] = useState(false);
  const selected = targets.find((target) => target.id === selectedId) ?? targets[0]!;

  useEffect(() => {
    let active = true;
    void window.cinesim.project
      .openTargets()
      .then((available) => {
        if (!active || available.length === 0) return;
        setTargets(available);
        setSelectedId((current) => {
          if (available.some((target) => target.id === current)) return current;
          rememberTarget("finder");
          return "finder";
        });
      })
      .catch(() => {
        // Finder remains available when optional application discovery fails.
      });
    return () => {
      active = false;
    };
  }, []);

  async function open(target: ProjectOpenTarget): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await window.cinesim.project.openWith(target.id);
    } catch {
      reportError(`The project could not be opened in ${target.label}`);
    }
    setBusy(false);
  }

  function select(target: ProjectOpenTarget): void {
    setSelectedId(target.id);
    rememberTarget(target.id);
    void open(target);
  }

  return (
    <div className="flex overflow-hidden rounded-md border border-border bg-panel shadow-sm">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon"
              variant="ghost"
              className="rounded-none border-0"
              aria-label={`Open project in ${selected.label}`}
              disabled={busy}
              onClick={() => void open(selected)}
            />
          }
        >
          {targetIcon(selected, "size-[17px]")}
        </TooltipTrigger>
        <TooltipContent>Open project in {selected.label}</TooltipContent>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-8 w-7 rounded-none border-l border-border px-0"
              aria-label="Choose where to open the project"
              disabled={busy}
            />
          }
        >
          <ChevronDown size={13} />
        </MenuTrigger>
        <MenuContent side="bottom" align="end" sideOffset={7} className="w-60">
          {targets.map((target) => (
            <MenuItem key={target.id} onClick={() => select(target)}>
              {targetIcon(target, "size-4")}
              <span className="min-w-0 flex-1 truncate">Open in {target.label}</span>
              {target.id === selected.id && <Check className="size-4 text-muted" />}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

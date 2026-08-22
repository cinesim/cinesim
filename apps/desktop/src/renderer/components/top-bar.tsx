import { Bug, ChevronDown, FolderOpen, Redo2, Save, Undo2 } from "lucide-react";
import { Button } from "@cinesim/ui";
import type { DesktopProjectSession } from "../../shared/api";
import { useUiStore } from "../store/ui-store";

interface TopBarProps {
  session: DesktopProjectSession;
  onSession: (session: DesktopProjectSession) => void;
}

export function TopBar({ session, onSession }: TopBarProps) {
  const showDebug = useUiStore((state) => state.showDebug);
  const setShowDebug = useUiStore((state) => state.setShowDebug);

  return (
    <header className="app-drag grid h-12 grid-cols-[260px_1fr_260px] items-center border-b border-border bg-panel px-3 pl-20">
      <div />
      <button
        className="no-drag mx-auto flex max-w-[360px] items-center gap-2 rounded-md px-3 py-1.5 text-ui text-secondary hover:bg-surface"
        onClick={() => void window.cinesim.revealProject()}
      >
        <span className="truncate font-medium">{session.project.name}</span>
        <ChevronDown size={12} className="text-muted" />
      </button>
      <div className="no-drag ml-auto flex items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Undo"
          disabled={!session.canUndo}
          onClick={() => void window.cinesim.undo().then(onSession)}
        >
          <Undo2 size={15} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Redo"
          disabled={!session.canRedo}
          onClick={() => void window.cinesim.redo().then(onSession)}
        >
          <Redo2 size={15} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Save project"
          onClick={() => void window.cinesim.save().then(onSession)}
        >
          <Save size={15} />
        </Button>
        <Button
          size="icon"
          variant={showDebug ? "secondary" : "ghost"}
          aria-label="Toggle debug metrics"
          onClick={() => setShowDebug(!showDebug)}
        >
          <Bug size={15} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Reveal project"
          onClick={() => void window.cinesim.revealProject()}
        >
          <FolderOpen size={15} />
        </Button>
      </div>
    </header>
  );
}

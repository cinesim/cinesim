import { Bug, FolderOpen, Redo2, Save, Undo2 } from "lucide-react";
import { Button } from "@cinesim/ui";
import type { DesktopProjectSession } from "../../shared/api";

interface TopBarProps {
  session: DesktopProjectSession;
  onSession: (session: DesktopProjectSession) => void;
  metricsOpen: boolean;
  onToggleMetrics: () => void;
}

export function TopBar({ session, onSession, metricsOpen, onToggleMetrics }: TopBarProps) {
  return (
    <div className="flex items-center gap-0.5">
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
        variant={metricsOpen ? "secondary" : "ghost"}
        aria-label={metricsOpen ? "Close Metrics sidebar" : "Open Metrics sidebar"}
        aria-pressed={metricsOpen}
        onClick={onToggleMetrics}
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
  );
}

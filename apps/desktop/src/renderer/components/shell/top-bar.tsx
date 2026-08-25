import { Bug, FolderOpen, Redo2, Save, Sparkles, Undo2 } from "lucide-react";
import { Button } from "@cinesim/ui";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";

interface TopBarProps {
  metricsOpen: boolean;
  onToggleMetrics: () => void;
  agentsOpen: boolean;
  onToggleAgents: () => void;
}

export function TopBar({ metricsOpen, onToggleMetrics, agentsOpen, onToggleAgents }: TopBarProps) {
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const undo = useRendererStore((state) => state.undo);
  const redo = useRendererStore((state) => state.redo);
  const save = useRendererStore((state) => state.save);
  const revealProject = useRendererStore((state) => state.revealProject);
  if (!session) return null;

  return (
    <div className="flex items-center gap-0.5">
      <Button
        size="icon"
        variant="ghost"
        aria-label="Undo"
        disabled={!session.canUndo}
        onClick={() => void undo()}
      >
        <Undo2 size={15} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Redo"
        disabled={!session.canRedo}
        onClick={() => void redo()}
      >
        <Redo2 size={15} />
      </Button>
      <Button size="icon" variant="ghost" aria-label="Save project" onClick={() => void save()}>
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
        variant={agentsOpen ? "secondary" : "ghost"}
        aria-label={agentsOpen ? "Close Agents sidebar" : "Open Agents sidebar"}
        aria-pressed={agentsOpen}
        onClick={onToggleAgents}
      >
        <Sparkles size={15} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Reveal project"
        onClick={() => void revealProject()}
      >
        <FolderOpen size={15} />
      </Button>
    </div>
  );
}

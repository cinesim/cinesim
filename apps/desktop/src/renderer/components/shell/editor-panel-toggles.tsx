import { Library, SlidersHorizontal, StickyNote } from "@cinesim/ui";
import { Button } from "@cinesim/ui";
import { useRendererStore } from "../../store/renderer-store-context";

export function EditorPanelToggles() {
  const mediaPoolOpen = useRendererStore((state) => state.mediaPoolOpen);
  const inspectorOpen = useRendererStore((state) => state.inspectorOpen);
  const notesOpen = useRendererStore((state) => state.notesOpen);
  const togglePanel = useRendererStore((state) => state.togglePanel);
  return (
    <div className="flex items-center gap-1">
      <Button
        size="icon"
        variant={mediaPoolOpen ? "secondary" : "ghost"}
        aria-label={mediaPoolOpen ? "Hide Media Pool" : "Show Media Pool"}
        aria-pressed={mediaPoolOpen}
        title={mediaPoolOpen ? "Hide Media Pool" : "Show Media Pool"}
        onClick={() => void togglePanel("mediaPool")}
      >
        <Library size={14} />
      </Button>
      <Button
        size="icon"
        variant={inspectorOpen ? "secondary" : "ghost"}
        aria-label={inspectorOpen ? "Hide Inspector" : "Show Inspector"}
        aria-pressed={inspectorOpen}
        title={inspectorOpen ? "Hide Inspector" : "Show Inspector"}
        onClick={() => void togglePanel("inspector")}
      >
        <SlidersHorizontal size={14} />
      </Button>
      <Button
        size="icon"
        variant={notesOpen ? "secondary" : "ghost"}
        aria-label={notesOpen ? "Hide Notes" : "Show Notes"}
        aria-pressed={notesOpen}
        title={notesOpen ? "Hide Notes" : "Show Notes"}
        onClick={() => void togglePanel("notes")}
      >
        <StickyNote size={14} />
      </Button>
    </div>
  );
}

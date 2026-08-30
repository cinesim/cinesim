import { useEffect, useRef } from "react";
import { canSplitClipAt, findClip } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import type { DesktopProjectSession, EditorLayoutState } from "../../../shared/api";
import { useElementBounds } from "../../hooks/use-element-bounds";
import { usePanelResize } from "../../hooks/use-panel-resize";
import { editShortcutAction } from "../../lib/edit-shortcuts";
import {
  editorRootGridTemplate,
  editorUpperGridTemplate,
  fitEditorLayout,
} from "../../lib/editor-layout";
import { isEditableKeyboardTarget } from "../../lib/keyboard-target";
import { useRendererStore } from "../../store/renderer-store-context";
import { EditMediaPool } from "../media/edit-media-pool";
import { Timeline } from "../timeline/timeline";
import { Viewer } from "../viewer/viewer";
import { EditorDndProvider } from "./editor-dnd-context";
import { Inspector } from "./inspector";
import { NotesPanel } from "./notes-panel";
import { PanelResizeHandle } from "./panel-resize-handle";

type EditResizeTarget = "mediaPool" | "inspector" | "notes" | "timeline";

interface EditWorkspaceProps {
  session: DesktopProjectSession;
  project: Project;
  sequenceId: string;
  initialLayout: EditorLayoutState;
  mediaPoolOpen: boolean;
  inspectorOpen: boolean;
  notesOpen: boolean;
}

export function EditWorkspace({
  session,
  project,
  sequenceId,
  initialLayout,
  mediaPoolOpen,
  inspectorOpen,
  notesOpen,
}: EditWorkspaceProps) {
  const layoutRootRef = useRef<HTMLDivElement>(null);
  const upperPanelsRef = useRef<HTMLDivElement>(null);
  const layoutBounds = useElementBounds(layoutRootRef);
  const execute = useRendererStore((state) => state.execute);
  const saveEditorLayout = useRendererStore((state) => state.saveEditorLayout);
  const selectClip = useRendererStore((state) => state.selectClip);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const setTool = useRendererStore((state) => state.setTool);
  const toggleSnapping = useRendererStore((state) => state.toggleSnapping);
  const panels = { mediaPool: mediaPoolOpen, inspector: inspectorOpen, notes: notesOpen };
  const resize = usePanelResize<EditResizeTarget, EditorLayoutState>({
    initialValue: initialLayout,
    fit: (value) => fitEditorLayout(value, layoutBounds, panels),
    move: (origin, target, delta) => {
      const next = { ...origin };
      if (target === "mediaPool") next.mediaPoolWidth += delta.x;
      else if (target === "inspector") next.inspectorWidth -= delta.x;
      else if (target === "notes") next.notesWidth -= delta.x;
      else next.timelineHeight -= delta.y;
      return next;
    },
    preview: (value) => {
      if (layoutRootRef.current)
        layoutRootRef.current.style.gridTemplateRows = editorRootGridTemplate(value);
      if (upperPanelsRef.current)
        upperPanelsRef.current.style.gridTemplateColumns = editorUpperGridTemplate(value, panels);
    },
    commit: saveEditorLayout,
  });
  const fittedLayout = fitEditorLayout(resize.value, layoutBounds, panels);

  useEffect(() => {
    function shortcut(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.repeat || isEditableKeyboardTarget(event.target)) return;
      const action = editShortcutAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "select-tool") setTool("select");
      else if (action === "trim-tool") setTool("trim");
      else if (action === "blade-tool") setTool("blade");
      else if (action === "toggle-snapping") toggleSnapping();
      else if (action === "delete-selection" && selectedClipId) {
        void execute({ type: "clip.remove", clipId: selectedClipId }).then((result) => {
          if (result.ok) selectClip(null);
        });
      } else if (action === "split-selection" && selectedClipId) {
        try {
          const { clip } = findClip(project, selectedClipId);
          if (canSplitClipAt(clip, playheadUs))
            void execute({ type: "clip.split", clipId: selectedClipId, atUs: playheadUs });
        } catch {
          // Selection reconciliation will clear a clip that no longer exists.
        }
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [execute, playheadUs, project, selectClip, selectedClipId, setTool, toggleSnapping]);

  return (
    <EditorDndProvider project={project}>
      <div
        ref={layoutRootRef}
        className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden"
        style={{ gridTemplateRows: editorRootGridTemplate(fittedLayout) }}
      >
        <div
          ref={upperPanelsRef}
          className="grid min-h-0"
          style={{ gridTemplateColumns: editorUpperGridTemplate(fittedLayout, panels) }}
        >
          {mediaPoolOpen && (
            <>
              <EditMediaPool project={project} sequenceId={sequenceId} />
              <PanelResizeHandle
                orientation="vertical"
                label="Resize Media Pool"
                {...resize.handleProps("mediaPool")}
              />
            </>
          )}
          <Viewer
            key={sequenceId}
            project={project}
            projectDirectory={session.directory}
            derivedScope={session.derivedScope}
            sequenceId={sequenceId}
          />
          {inspectorOpen && (
            <>
              <PanelResizeHandle
                orientation="vertical"
                label="Resize Inspector"
                {...resize.handleProps("inspector")}
              />
              <Inspector project={project} />
            </>
          )}
          {notesOpen && (
            <>
              <PanelResizeHandle
                orientation="vertical"
                label="Resize Notes"
                {...resize.handleProps("notes")}
              />
              <NotesPanel />
            </>
          )}
        </div>
        <PanelResizeHandle
          orientation="horizontal"
          label="Resize Timeline"
          {...resize.handleProps("timeline")}
        />
        <Timeline project={project} />
      </div>
    </EditorDndProvider>
  );
}

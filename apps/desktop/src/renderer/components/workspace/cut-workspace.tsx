import { useCallback, useRef, useState } from "react";
import type { Project, TimelineRange } from "@cinesim/core";
import type { CutLayoutState, DesktopProjectSession } from "../../../shared/contracts";
import { useElementBounds } from "../../hooks/use-element-bounds";
import { usePanelResize } from "../../hooks/use-panel-resize";
import {
  cutRightGridTemplate,
  cutRootGridTemplate,
  cutUpperGridTemplate,
  fitCutLayout,
} from "../../lib/cut-layout";
import { useRendererStore } from "../../store/renderer-store-context";
import { EditMediaPool } from "../media/edit-media-pool";
import { Timeline } from "../timeline/timeline";
import { TimelineTranscript } from "../transcript/timeline-transcript";
import { Viewer } from "../viewer/viewer";
import { EditorDndProvider } from "./editor-dnd-context";
import { PanelResizeHandle } from "./panel-resize-handle";

type CutResizeTarget = "column" | "viewer" | "timeline";

interface CutWorkspaceProps {
  session: DesktopProjectSession;
  project: Project;
  sequenceId: string;
  initialLayout: CutLayoutState;
}

export function CutWorkspace({ session, project, sequenceId, initialLayout }: CutWorkspaceProps) {
  const [selectedRanges, setSelectedRanges] = useState<TimelineRange[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const upperRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const bounds = useElementBounds(rootRef);
  const saveCutLayout = useRendererStore((state) => state.saveCutLayout);
  const resize = usePanelResize<CutResizeTarget, CutLayoutState>({
    initialValue: initialLayout,
    fit: (value) => fitCutLayout(value, bounds),
    move: (origin, target, delta) => {
      const next = { ...origin };
      if (target === "column") next.rightColumnWidth -= delta.x;
      else if (target === "viewer") next.viewerHeight += delta.y;
      else next.timelineHeight -= delta.y;
      return next;
    },
    preview: (value) => {
      if (rootRef.current) rootRef.current.style.gridTemplateRows = cutRootGridTemplate(value);
      if (upperRef.current)
        upperRef.current.style.gridTemplateColumns = cutUpperGridTemplate(value);
      if (rightRef.current) rightRef.current.style.gridTemplateRows = cutRightGridTemplate(value);
    },
    commit: saveCutLayout,
  });
  const fitted = fitCutLayout(resize.value, bounds);
  const acceptSelection = useCallback((ranges: TimelineRange[]) => {
    setSelectedRanges((current) => {
      if (
        current.length === ranges.length &&
        current.every(
          (range, index) =>
            range.startUs === ranges[index]?.startUs && range.endUs === ranges[index]?.endUs,
        )
      )
        return current;
      return ranges;
    });
  }, []);

  return (
    <EditorDndProvider project={project}>
      <div
        ref={rootRef}
        className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden"
        style={{ gridTemplateRows: cutRootGridTemplate(fitted) }}
      >
        <div
          ref={upperRef}
          className="grid min-h-0 min-w-0 overflow-hidden"
          style={{ gridTemplateColumns: cutUpperGridTemplate(fitted) }}
        >
          <TimelineTranscript
            project={project}
            sequenceId={sequenceId}
            derivedScope={session.derivedScope}
            markers={(session.timelines[sequenceId] ?? session.timeline).markers}
            onSelectionChange={acceptSelection}
          />
          <PanelResizeHandle
            orientation="vertical"
            label="Resize transcript and preview"
            {...resize.handleProps("column")}
          />
          <div
            ref={rightRef}
            className="grid min-h-0 min-w-0 overflow-hidden"
            style={{ gridTemplateRows: cutRightGridTemplate(fitted) }}
          >
            <Viewer
              key={sequenceId}
              project={project}
              program={session.program}
              settings={session.settings}
              projectDirectory={session.directory}
              derivedScope={session.derivedScope}
              sequenceId={sequenceId}
            />
            <PanelResizeHandle
              orientation="horizontal"
              label="Resize viewer and Media Pool"
              {...resize.handleProps("viewer")}
            />
            <EditMediaPool project={project} sequenceId={sequenceId} />
          </div>
        </div>
        <PanelResizeHandle
          orientation="horizontal"
          label="Resize Timeline"
          {...resize.handleProps("timeline")}
        />
        <Timeline
          project={project}
          timeline={session.timelines[sequenceId] ?? session.timeline}
          selectedRanges={selectedRanges}
        />
      </div>
    </EditorDndProvider>
  );
}

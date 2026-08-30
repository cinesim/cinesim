import { useCallback, useEffect, useRef, useState } from "react";
import { timeUs } from "@cinesim/core";
import type { Project, TimelineRange, TimeUs } from "@cinesim/core";
import type { CutLayoutState, DesktopProjectSession } from "../../../shared/api";
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
import type { ViewerController } from "../viewer/viewer";
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
  const auditionEndUs = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const upperRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const viewerControllerRef = useRef<ViewerController | null>(null);
  const setViewerController = useCallback((controller: ViewerController | null) => {
    viewerControllerRef.current = controller;
  }, []);
  const bounds = useElementBounds(rootRef);
  const transcripts = useRendererStore((state) => state.transcripts);
  const account = useRendererStore((state) => state.account);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const playbackPlaying = useRendererStore(
    (state) => state.playbackRuntime?.snapshot.playing ?? false,
  );
  const execute = useRendererStore((state) => state.execute);
  const importMedia = useRendererStore((state) => state.importMedia);
  const appendAsset = useRendererStore((state) => state.appendAsset);
  const requestTranscripts = useRendererStore((state) => state.requestTranscripts);
  const cancelTranscripts = useRendererStore((state) => state.cancelTranscripts);
  const saveCutLayout = useRendererStore((state) => state.saveCutLayout);
  const setPlayheadUs = useRendererStore((state) => state.setPlayheadUs);
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

  useEffect(() => {
    if (auditionEndUs.current === null || !playbackPlaying || playheadUs < auditionEndUs.current)
      return;
    viewerControllerRef.current?.pauseTimeline();
    auditionEndUs.current = null;
  }, [playbackPlaying, playheadUs]);

  function handleSeek(timeUs: TimeUs): void {
    setPlayheadUs(timeUs);
    void viewerControllerRef.current?.seekTimeline(timeUs);
  }

  return (
    <EditorDndProvider
      project={project}
      onCommand={execute}
      onAssetDragStart={() => void viewerControllerRef.current?.exitAssetPreview()}
    >
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
            transcripts={transcripts}
            account={account}
            playheadUs={playheadUs}
            onSeek={handleSeek}
            onCommand={execute}
            onRequestTranscripts={requestTranscripts}
            onCancelTranscripts={cancelTranscripts}
            onSelectionChange={acceptSelection}
            onPlaySelection={(startUs, endUs) => {
              auditionEndUs.current = endUs;
              void viewerControllerRef.current
                ?.seekTimeline(startUs)
                .then(() => viewerControllerRef.current?.playTimeline());
            }}
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
              projectDirectory={session.directory}
              derivedScope={session.derivedScope}
              sequenceId={sequenceId}
              onController={setViewerController}
            />
            <PanelResizeHandle
              orientation="horizontal"
              label="Resize viewer and Media Pool"
              {...resize.handleProps("viewer")}
            />
            <EditMediaPool
              project={project}
              onAddAsset={(asset) => appendAsset(asset.id, sequenceId)}
              onImport={importMedia}
              onPreviewAsset={(asset, sourceTimeUs) =>
                viewerControllerRef.current?.enterAssetPreview(asset.id, sourceTimeUs)
              }
              onPreviewEnd={() => void viewerControllerRef.current?.exitAssetPreview()}
            />
          </div>
        </div>
        <PanelResizeHandle
          orientation="horizontal"
          label="Resize Timeline"
          {...resize.handleProps("timeline")}
        />
        <Timeline
          project={project}
          transcripts={transcripts}
          selectedRanges={selectedRanges}
          onCommand={execute}
          onSeek={handleSeek}
          onTogglePlayback={() => {
            auditionEndUs.current = null;
            if (playbackPlaying) viewerControllerRef.current?.pauseTimeline();
            else viewerControllerRef.current?.playTimeline();
          }}
          onGoToStart={() => handleSeek(timeUs(0))}
          onStepFrames={(deltaFrames) => void viewerControllerRef.current?.stepFrames(deltaFrames)}
        />
      </div>
    </EditorDndProvider>
  );
}

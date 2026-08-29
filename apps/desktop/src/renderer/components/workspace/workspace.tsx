import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@cinesim/ui";
import { canSplitClipAt, findClip } from "@cinesim/core";
import type { Asset, EditorCommand, Project, SequenceId, TimelineRange } from "@cinesim/core";
import { EDITOR_LAYOUT_LIMITS } from "../../../shared/api";
import type { CutLayoutState, DesktopProjectSession, EditorLayoutState } from "../../../shared/api";
import { editShortcutAction } from "../../lib/edit-shortcuts";
import {
  cutRightGridTemplate,
  cutRootGridTemplate,
  cutUpperGridTemplate,
  fitCutLayout,
} from "../../lib/cut-layout";
import { useRendererStore } from "../../store/renderer-store-context";
import { EditMediaPool } from "../media/edit-media-pool";
import { MediaBin } from "../media/media-bin";
import { Timeline } from "../timeline/timeline";
import { TimelineTranscript } from "../transcript/timeline-transcript";
import { Viewer } from "../viewer/viewer";
import type { ViewerController } from "../viewer/viewer";
import { EditorDndProvider } from "./editor-dnd-context";
import { Inspector } from "./inspector";
import { NotesPanel } from "./notes-panel";

interface WorkspaceProps {
  session: DesktopProjectSession;
  section: "media" | "cut" | "edit";
  activeSequenceId: string;
  mediaPoolOpen: boolean;
  inspectorOpen: boolean;
  notesOpen: boolean;
  editorLayout: EditorLayoutState;
  cutLayout: CutLayoutState;
  onOpenTimeline: (sequenceId: string) => void;
}

type ResizeTarget = "mediaPool" | "inspector" | "notes" | "timeline";

const SPLITTER_SIZE = 1;
const MIN_VIEWER_WIDTH = 320;
const MIN_VIEWER_HEIGHT = 220;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function fitLayout(
  layout: EditorLayoutState,
  bounds: { width: number; height: number },
  mediaPoolOpen: boolean,
  inspectorOpen: boolean,
  notesOpen: boolean,
): EditorLayoutState {
  const splitterCount = Number(mediaPoolOpen) + Number(inspectorOpen) + Number(notesOpen);
  const notesAvailable =
    bounds.width > 0
      ? bounds.width -
        MIN_VIEWER_WIDTH -
        SPLITTER_SIZE * splitterCount -
        (mediaPoolOpen ? EDITOR_LAYOUT_LIMITS.mediaPoolWidth.min : 0) -
        (inspectorOpen ? EDITOR_LAYOUT_LIMITS.inspectorWidth.min : 0)
      : EDITOR_LAYOUT_LIMITS.notesWidth.max;
  const notesWidth = notesOpen
    ? clamp(
        layout.notesWidth,
        EDITOR_LAYOUT_LIMITS.notesWidth.min,
        Math.min(EDITOR_LAYOUT_LIMITS.notesWidth.max, notesAvailable),
      )
    : layout.notesWidth;
  const inspectorAvailable =
    bounds.width > 0
      ? bounds.width -
        MIN_VIEWER_WIDTH -
        SPLITTER_SIZE * splitterCount -
        (mediaPoolOpen ? EDITOR_LAYOUT_LIMITS.mediaPoolWidth.min : 0) -
        (notesOpen ? notesWidth : 0)
      : EDITOR_LAYOUT_LIMITS.inspectorWidth.max;
  const inspectorWidth = inspectorOpen
    ? clamp(
        layout.inspectorWidth,
        EDITOR_LAYOUT_LIMITS.inspectorWidth.min,
        Math.min(EDITOR_LAYOUT_LIMITS.inspectorWidth.max, inspectorAvailable),
      )
    : layout.inspectorWidth;
  const mediaAvailable =
    bounds.width > 0
      ? bounds.width -
        MIN_VIEWER_WIDTH -
        SPLITTER_SIZE * splitterCount -
        (inspectorOpen ? inspectorWidth : 0) -
        (notesOpen ? notesWidth : 0)
      : EDITOR_LAYOUT_LIMITS.mediaPoolWidth.max;
  const timelineAvailable =
    bounds.height > 0
      ? bounds.height - MIN_VIEWER_HEIGHT - SPLITTER_SIZE
      : EDITOR_LAYOUT_LIMITS.timelineHeight.max;
  return {
    mediaPoolWidth: mediaPoolOpen
      ? clamp(
          layout.mediaPoolWidth,
          EDITOR_LAYOUT_LIMITS.mediaPoolWidth.min,
          Math.min(EDITOR_LAYOUT_LIMITS.mediaPoolWidth.max, mediaAvailable),
        )
      : layout.mediaPoolWidth,
    inspectorWidth,
    notesWidth,
    timelineHeight: clamp(
      layout.timelineHeight,
      EDITOR_LAYOUT_LIMITS.timelineHeight.min,
      Math.min(EDITOR_LAYOUT_LIMITS.timelineHeight.max, timelineAvailable),
    ),
  };
}

function upperGridTemplate(
  layout: EditorLayoutState,
  mediaPoolOpen: boolean,
  inspectorOpen: boolean,
  notesOpen: boolean,
): string {
  const columns: string[] = [];
  if (mediaPoolOpen) columns.push(`${layout.mediaPoolWidth}px`, `${SPLITTER_SIZE}px`);
  columns.push(`minmax(${MIN_VIEWER_WIDTH}px, 1fr)`);
  if (inspectorOpen) columns.push(`${SPLITTER_SIZE}px`, `${layout.inspectorWidth}px`);
  if (notesOpen) columns.push(`${SPLITTER_SIZE}px`, `${layout.notesWidth}px`);
  return columns.join(" ");
}

type CutResizeTarget = "column" | "viewer" | "timeline";

function CutWorkspace({
  session,
  project,
  sequenceId,
  initialLayout,
  viewerControllerRef,
  setViewerController,
  onCommand,
  onImport,
  onAddAsset,
}: {
  session: DesktopProjectSession;
  project: Project;
  sequenceId: string;
  initialLayout: CutLayoutState;
  viewerControllerRef: React.RefObject<ViewerController | null>;
  setViewerController: (controller: ViewerController | null) => void;
  onCommand: (
    command: EditorCommand,
  ) => Promise<import("../../store/renderer-store").ActionResult<unknown>>;
  onImport: () => Promise<unknown>;
  onAddAsset: (asset: Asset) => Promise<unknown>;
}) {
  const [layout, setLayout] = useState(initialLayout);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [selectedRanges, setSelectedRanges] = useState<TimelineRange[]>([]);
  const auditionEndUs = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const upperRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(initialLayout);
  const resizeOrigin = useRef<{
    target: CutResizeTarget;
    x: number;
    y: number;
    layout: CutLayoutState;
  } | null>(null);
  const transcripts = useRendererStore((state) => state.transcripts);
  const account = useRendererStore((state) => state.account);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const playbackPlaying = useRendererStore(
    (state) => state.playbackRuntime?.snapshot.playing ?? false,
  );
  const requestTranscripts = useRendererStore((state) => state.requestTranscripts);
  const cancelTranscripts = useRendererStore((state) => state.cancelTranscripts);
  const saveCutLayout = useRendererStore((state) => state.saveCutLayout);
  const setPlayheadUs = useRendererStore((state) => state.setPlayheadUs);
  const fitted = fitCutLayout(layout, bounds);
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
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setBounds({ width: root.clientWidth, height: root.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (auditionEndUs.current === null || !playbackPlaying || playheadUs < auditionEndUs.current)
      return;
    viewerControllerRef.current?.pauseTimeline();
    auditionEndUs.current = null;
  }, [playbackPlaying, playheadUs, viewerControllerRef]);

  function applyTransient(next: CutLayoutState): void {
    const value = fitCutLayout(next, bounds);
    if (rootRef.current) rootRef.current.style.gridTemplateRows = cutRootGridTemplate(value);
    if (upperRef.current) upperRef.current.style.gridTemplateColumns = cutUpperGridTemplate(value);
    if (rightRef.current) rightRef.current.style.gridTemplateRows = cutRightGridTemplate(value);
    layoutRef.current = value;
  }

  function startResize(target: CutResizeTarget, event: React.PointerEvent<HTMLDivElement>): void {
    resizeOrigin.current = {
      target,
      x: event.clientX,
      y: event.clientY,
      layout: fitCutLayout(layoutRef.current, bounds),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveResize(target: CutResizeTarget, event: React.PointerEvent<HTMLDivElement>): void {
    const origin = resizeOrigin.current;
    if (!origin || origin.target !== target) return;
    const next = { ...origin.layout };
    if (target === "column") next.rightColumnWidth += origin.x - event.clientX;
    else if (target === "viewer") next.viewerHeight += event.clientY - origin.y;
    else next.timelineHeight += origin.y - event.clientY;
    applyTransient(next);
  }

  function finishResize(target: CutResizeTarget, event: React.PointerEvent<HTMLDivElement>): void {
    if (resizeOrigin.current?.target !== target) return;
    resizeOrigin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setLayout(layoutRef.current);
    void saveCutLayout(layoutRef.current);
  }

  function cancelResize(target: CutResizeTarget, _event: React.PointerEvent<HTMLDivElement>): void {
    const origin = resizeOrigin.current;
    if (!origin || origin.target !== target) return;
    resizeOrigin.current = null;
    applyTransient(origin.layout);
    setLayout(origin.layout);
  }

  function handleSeek(timeUs: number): void {
    setPlayheadUs(timeUs);
    void viewerControllerRef.current?.seekTimeline(timeUs);
  }

  return (
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
          onCommand={onCommand}
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
          onPointerDown={(event) => startResize("column", event)}
          onPointerMove={(event) => moveResize("column", event)}
          onPointerUp={(event) => finishResize("column", event)}
          onPointerCancel={(event) => cancelResize("column", event)}
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
            onPointerDown={(event) => startResize("viewer", event)}
            onPointerMove={(event) => moveResize("viewer", event)}
            onPointerUp={(event) => finishResize("viewer", event)}
            onPointerCancel={(event) => cancelResize("viewer", event)}
          />
          <EditMediaPool
            project={project}
            onAddAsset={onAddAsset}
            onImport={onImport}
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
        onPointerDown={(event) => startResize("timeline", event)}
        onPointerMove={(event) => moveResize("timeline", event)}
        onPointerUp={(event) => finishResize("timeline", event)}
        onPointerCancel={(event) => cancelResize("timeline", event)}
      />
      <Timeline
        project={project}
        transcripts={transcripts}
        selectedRanges={selectedRanges}
        onCommand={onCommand}
        onSeek={handleSeek}
        onTogglePlayback={() => {
          auditionEndUs.current = null;
          if (playbackPlaying) viewerControllerRef.current?.pauseTimeline();
          else viewerControllerRef.current?.playTimeline();
        }}
        onGoToStart={() => handleSeek(0)}
        onStepFrames={(deltaFrames) => void viewerControllerRef.current?.stepFrames(deltaFrames)}
      />
    </div>
  );
}

export function Workspace({
  session,
  section,
  activeSequenceId,
  mediaPoolOpen,
  inspectorOpen,
  notesOpen,
  editorLayout,
  cutLayout,
  onOpenTimeline,
}: WorkspaceProps) {
  const [layout, setLayout] = useState(editorLayout);
  const [layoutBounds, setLayoutBounds] = useState({ width: 0, height: 0 });
  const layoutRootRef = useRef<HTMLDivElement>(null);
  const upperPanelsRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(editorLayout);
  const resizeOrigin = useRef<{
    target: ResizeTarget;
    x: number;
    y: number;
    layout: EditorLayoutState;
  } | null>(null);
  const viewerControllerRef = useRef<ViewerController | null>(null);
  const setViewerController = useCallback((controller: ViewerController | null) => {
    viewerControllerRef.current = controller;
  }, []);
  const error = useRendererStore((state) => state.operationError);
  const clearError = useRendererStore((state) => state.clearError);
  const execute = useRendererStore((state) => state.execute);
  const importProjectMedia = useRendererStore((state) => state.importMedia);
  const appendAsset = useRendererStore((state) => state.appendAsset);
  const saveEditorLayout = useRendererStore((state) => state.saveEditorLayout);
  const selectClip = useRendererStore((state) => state.selectClip);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const playbackPlaying = useRendererStore(
    (state) => state.playbackRuntime?.snapshot.playing ?? false,
  );
  const transcripts = useRendererStore((state) => state.transcripts);
  const loadTranscripts = useRendererStore((state) => state.loadTranscripts);
  const setPlayheadUs = useRendererStore((state) => state.setPlayheadUs);
  const setTool = useRendererStore((state) => state.setTool);
  const toggleSnapping = useRendererStore((state) => state.toggleSnapping);
  const activeSequence =
    session.project.sequences.find((sequence) => sequence.id === activeSequenceId) ??
    session.project.sequences.find(
      (sequence) => sequence.id === session.project.activeSequenceId,
    ) ??
    null;
  const editorProject = useMemo(
    () =>
      activeSequence
        ? { ...session.project, activeSequenceId: activeSequence.id as SequenceId }
        : session.project,
    [activeSequence, session.project],
  );
  const fittedLayout = fitLayout(layout, layoutBounds, mediaPoolOpen, inspectorOpen, notesOpen);

  useEffect(() => {
    const element = layoutRootRef.current;
    if (!element) return;
    const updateBounds = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setLayoutBounds((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeSequence?.id, section]);

  useEffect(() => {
    selectClip(null);
    setPlayheadUs(0);
  }, [activeSequence?.id, selectClip, setPlayheadUs]);

  useEffect(() => {
    if (!activeSequence || (section !== "cut" && section !== "edit")) return;
    const assetIds = [
      ...new Set(activeSequence.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId))),
    ].filter(
      (assetId) =>
        !transcripts ||
        (transcripts.assets[assetId]?.state === "ready" &&
          transcripts.assets[assetId]?.artifact === undefined),
    );
    if (assetIds.length) void loadTranscripts(assetIds);
  }, [activeSequence, loadTranscripts, section, transcripts]);

  useEffect(() => {
    if (section !== "edit") return;
    function shortcut(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) return;
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
          const { clip } = findClip(editorProject, selectedClipId);
          if (canSplitClipAt(clip, playheadUs))
            void execute({ type: "clip.split", clipId: selectedClipId, atUs: playheadUs });
        } catch {
          // Selection reconciliation will clear a clip that no longer exists.
        }
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [
    editorProject,
    execute,
    playheadUs,
    section,
    selectClip,
    selectedClipId,
    setTool,
    toggleSnapping,
  ]);

  function applyTransientLayout(next: EditorLayoutState): void {
    const fitted = fitLayout(next, layoutBounds, mediaPoolOpen, inspectorOpen, notesOpen);
    if (layoutRootRef.current)
      layoutRootRef.current.style.gridTemplateRows = `minmax(${MIN_VIEWER_HEIGHT}px, 1fr) ${SPLITTER_SIZE}px ${fitted.timelineHeight}px`;
    if (upperPanelsRef.current)
      upperPanelsRef.current.style.gridTemplateColumns = upperGridTemplate(
        fitted,
        mediaPoolOpen,
        inspectorOpen,
        notesOpen,
      );
    layoutRef.current = fitted;
  }

  function startResize(target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>): void {
    const current = fitLayout(
      layoutRef.current,
      layoutBounds,
      mediaPoolOpen,
      inspectorOpen,
      notesOpen,
    );
    resizeOrigin.current = {
      target,
      x: event.clientX,
      y: event.clientY,
      layout: current,
    };
    layoutRef.current = current;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveResize(target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>): void {
    const origin = resizeOrigin.current;
    if (!origin || origin.target !== target) return;
    const next = { ...origin.layout };
    if (target === "mediaPool")
      next.mediaPoolWidth = origin.layout.mediaPoolWidth + event.clientX - origin.x;
    else if (target === "inspector")
      next.inspectorWidth = origin.layout.inspectorWidth + origin.x - event.clientX;
    else if (target === "notes")
      next.notesWidth = origin.layout.notesWidth + origin.x - event.clientX;
    else next.timelineHeight = origin.layout.timelineHeight + origin.y - event.clientY;
    applyTransientLayout(next);
  }

  function finishResize(target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>): void {
    const origin = resizeOrigin.current;
    if (!origin || origin.target !== target) return;
    resizeOrigin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const committed = layoutRef.current;
    setLayout(committed);
    void saveEditorLayout(committed);
  }

  function cancelResize(target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>): void {
    const origin = resizeOrigin.current;
    if (!origin || origin.target !== target) return;
    resizeOrigin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    applyTransientLayout(origin.layout);
    setLayout(origin.layout);
  }

  async function command(input: EditorCommand) {
    return execute(input);
  }

  async function importMedia() {
    return importProjectMedia();
  }

  async function addAsset(asset: Asset) {
    if (!activeSequence)
      return { ok: false as const, error: "The active timeline is no longer available" };
    return appendAsset(asset.id, activeSequence.id);
  }

  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden bg-canvas">
      {section === "media" ? (
        <MediaBin project={session.project} onOpenTimeline={onOpenTimeline} />
      ) : activeSequence ? (
        <EditorDndProvider
          project={editorProject}
          onCommand={command}
          onAssetDragStart={() => void viewerControllerRef.current?.exitAssetPreview()}
        >
          {section === "cut" ? (
            <CutWorkspace
              session={session}
              project={editorProject}
              sequenceId={activeSequence.id}
              initialLayout={cutLayout}
              viewerControllerRef={viewerControllerRef}
              setViewerController={setViewerController}
              onCommand={command}
              onImport={importMedia}
              onAddAsset={addAsset}
            />
          ) : (
            <div
              ref={layoutRootRef}
              className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden"
              style={{
                gridTemplateRows: `minmax(${MIN_VIEWER_HEIGHT}px, 1fr) ${SPLITTER_SIZE}px ${fittedLayout.timelineHeight}px`,
              }}
            >
              <div
                ref={upperPanelsRef}
                className="grid min-h-0"
                style={{
                  gridTemplateColumns: upperGridTemplate(
                    fittedLayout,
                    mediaPoolOpen,
                    inspectorOpen,
                    notesOpen,
                  ),
                }}
              >
                {mediaPoolOpen && (
                  <>
                    <EditMediaPool
                      project={editorProject}
                      onAddAsset={addAsset}
                      onImport={importMedia}
                      onPreviewAsset={(asset, sourceTimeUs) =>
                        viewerControllerRef.current?.enterAssetPreview(asset.id, sourceTimeUs)
                      }
                      onPreviewEnd={() => void viewerControllerRef.current?.exitAssetPreview()}
                    />
                    <PanelResizeHandle
                      orientation="vertical"
                      label="Resize Media Pool"
                      onPointerDown={(event) => startResize("mediaPool", event)}
                      onPointerMove={(event) => moveResize("mediaPool", event)}
                      onPointerUp={(event) => finishResize("mediaPool", event)}
                      onPointerCancel={(event) => cancelResize("mediaPool", event)}
                    />
                  </>
                )}
                <Viewer
                  key={activeSequence.id}
                  project={editorProject}
                  projectDirectory={session.directory}
                  derivedScope={session.derivedScope}
                  sequenceId={activeSequence.id}
                  onController={setViewerController}
                />
                {inspectorOpen && (
                  <>
                    <PanelResizeHandle
                      orientation="vertical"
                      label="Resize Inspector"
                      onPointerDown={(event) => startResize("inspector", event)}
                      onPointerMove={(event) => moveResize("inspector", event)}
                      onPointerUp={(event) => finishResize("inspector", event)}
                      onPointerCancel={(event) => cancelResize("inspector", event)}
                    />
                    <Inspector project={editorProject} />
                  </>
                )}
                {notesOpen && (
                  <>
                    <PanelResizeHandle
                      orientation="vertical"
                      label="Resize Notes"
                      onPointerDown={(event) => startResize("notes", event)}
                      onPointerMove={(event) => moveResize("notes", event)}
                      onPointerUp={(event) => finishResize("notes", event)}
                      onPointerCancel={(event) => cancelResize("notes", event)}
                    />
                    <NotesPanel />
                  </>
                )}
              </div>
              <PanelResizeHandle
                orientation="horizontal"
                label="Resize Timeline"
                onPointerDown={(event) => startResize("timeline", event)}
                onPointerMove={(event) => moveResize("timeline", event)}
                onPointerUp={(event) => finishResize("timeline", event)}
                onPointerCancel={(event) => cancelResize("timeline", event)}
              />
              <Timeline
                project={editorProject}
                transcripts={transcripts}
                onCommand={command}
                onSeek={(timeUs) => void viewerControllerRef.current?.seekTimeline(timeUs)}
                onTogglePlayback={() => {
                  if (playbackPlaying) viewerControllerRef.current?.pauseTimeline();
                  else viewerControllerRef.current?.playTimeline();
                }}
                onGoToStart={() => void viewerControllerRef.current?.seekTimeline(0)}
                onStepFrames={(deltaFrames) =>
                  void viewerControllerRef.current?.stepFrames(deltaFrames)
                }
              />
            </div>
          )}
        </EditorDndProvider>
      ) : null}

      {error && (
        <button
          className="absolute bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-border-strong bg-panel px-4 py-2 text-ui text-primary shadow-xl"
          onClick={clearError}
        >
          {error}
        </button>
      )}
    </div>
  );
}

interface PanelResizeHandleProps {
  orientation: "horizontal" | "vertical";
  label: string;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
}

function PanelResizeHandle({
  orientation,
  label,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: PanelResizeHandleProps) {
  return (
    <div
      className={cn(
        "group relative z-20 touch-none bg-border transition-colors hover:bg-accent",
        orientation === "vertical" ? "cursor-col-resize" : "cursor-row-resize",
      )}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      <span
        className={cn(
          "absolute",
          orientation === "vertical"
            ? "inset-y-0 left-1/2 w-[7px] -translate-x-1/2"
            : "inset-x-0 top-1/2 h-[7px] -translate-y-1/2",
        )}
      />
    </div>
  );
}

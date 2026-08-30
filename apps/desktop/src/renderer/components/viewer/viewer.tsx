import { useEffect, useRef, useState } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cinesim/ui";
import { getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import type { DerivedProjectScope } from "../../../shared/contracts";
import { useEditorTransport } from "../workspace/editor-transport-context";
import { usePlaybackShortcuts } from "./use-playback-shortcuts";
import { useViewerRuntime } from "./use-viewer-runtime";
import { DEFAULT_VIEWER_GUIDES, ViewerGuideOverlay } from "./viewer-guides";
import { ViewerHeader } from "./viewer-header";
import { shouldShowTimelineEmptyState, viewerDisplaySize } from "./viewer-helpers";
import type { ViewerScale } from "./viewer-helpers";

interface ViewerProps {
  derivedScope: DerivedProjectScope;
  project: Project;
  projectDirectory: string;
  sequenceId: string;
}

export function Viewer({ project, projectDirectory, derivedScope, sequenceId }: ViewerProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [viewerScale, setViewerScale] = useState<ViewerScale>("fit");
  const [guides, setGuides] = useState(DEFAULT_VIEWER_GUIDES);
  const transport = useEditorTransport();
  const { playbackRef, runtime } = useViewerRuntime({
    canvasRef,
    derivedScope,
    project,
    projectDirectory,
    sequenceId,
    onController: transport.registerController,
  });
  usePlaybackShortcuts(playbackRef, project);
  const sequence = getSequence(project);
  const durationUs = sequenceDurationUs(sequence);
  const displaySize = viewerDisplaySize(sequence, stageSize, viewerScale);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const resize = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (displaySize.width <= 1 || displaySize.height <= 1) return;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void playbackRef.current?.refresh();
    }, 100);
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [displaySize.height, displaySize.width, playbackRef]);

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await sectionRef.current?.requestFullscreen();
  }

  return (
    <section
      ref={sectionRef}
      className="viewer-panel relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel-muted"
    >
      <ViewerHeader
        frameRate={sequence.frameRate}
        guides={guides}
        height={sequence.height}
        runtime={runtime}
        scale={viewerScale}
        width={sequence.width}
        onFullscreen={() => void toggleFullscreen()}
        onGuidesChange={setGuides}
        onScaleChange={setViewerScale}
      />
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto bg-canvas">
        <div
          className="grid place-items-center p-5"
          style={{
            minWidth: "100%",
            minHeight: "100%",
            width: displaySize.width + 40,
            height: displaySize.height + 40,
          }}
        >
          <div
            className="relative shrink-0 overflow-hidden bg-black shadow-xl shadow-black/15"
            style={{ width: displaySize.width, height: displaySize.height }}
          >
            <canvas ref={canvasRef} className="block h-full w-full bg-black" />
            <ViewerGuideOverlay guides={guides} />
          </div>
        </div>
        {shouldShowTimelineEmptyState(durationUs, runtime?.mode ?? null) && (
          <Empty className="pointer-events-none absolute inset-0">
            <EmptyHeader>
              <EmptyTitle>
                {project.assets.length === 0 ? "The viewer is ready" : "This timeline is empty"}
              </EmptyTitle>
              <EmptyDescription>
                {project.assets.length === 0
                  ? "Import media and add it to the timeline"
                  : "Drag media from the Media Pool onto a timeline track"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cinesim/ui";
import { getSequence, sequenceDurationUs } from "@cinesim/core";
import type { Project, ProjectSettings } from "@cinesim/core";
import type { IrProgram, IrTransform } from "@cinesim/ir";
import type { DerivedProjectScope } from "../../../shared/contracts";
import { useEditorTransport } from "../workspace/editor-transport-context";
import { useRendererStore } from "../../store/renderer-store-context";
import { usePlaybackShortcuts } from "./use-playback-shortcuts";
import { useViewerRuntime } from "./use-viewer-runtime";
import { DEFAULT_VIEWER_GUIDES, ViewerGuideOverlay } from "./viewer-guides";
import { ViewerHeader } from "./viewer-header";
import { shouldShowTimelineEmptyState, viewerDisplaySize } from "./viewer-helpers";
import type { ViewerScale } from "./viewer-helpers";
import { transformGestureUpdates, type TransformGestureKind } from "./viewer-transform-geometry";
import { ViewerTransformOverlay } from "./viewer-transform-overlay";
import { programWithClipTransform, selectedVisualClip } from "./viewer-transform-program";

interface ViewerProps {
  derivedScope: DerivedProjectScope;
  project: Project;
  settings: ProjectSettings;
  program: IrProgram;
  projectDirectory: string;
  sequenceId: string;
}

interface OptimisticClipTransform {
  clipId: string;
  program: IrProgram;
  transform: IrTransform;
}

export function Viewer({
  project,
  program,
  projectDirectory,
  derivedScope,
  settings,
  sequenceId,
}: ViewerProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [viewerScale, setViewerScale] = useState<ViewerScale>("fit");
  const [guides, setGuides] = useState(DEFAULT_VIEWER_GUIDES);
  const [optimistic, setOptimistic] = useState<OptimisticClipTransform | null>(null);
  const [transformCommitPending, setTransformCommitPending] = useState(false);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const execute = useRendererStore((state) => state.execute);
  const transport = useEditorTransport();
  const selection = selectedVisualClip(program, sequenceId, selectedClipId, playheadUs);
  const optimisticTransform =
    optimistic?.program === program && optimistic.clipId === selection?.clip.id
      ? optimistic.transform
      : null;
  const displayedTransform = optimisticTransform ?? selection?.clip.transform ?? null;
  const displayedProgram = useMemo(
    () =>
      selection && optimisticTransform
        ? programWithClipTransform(program, selection.clip.id, optimisticTransform)
        : program,
    [optimisticTransform, program, selection],
  );
  const { playbackRef, runtime } = useViewerRuntime({
    canvasRef,
    derivedScope,
    project,
    settings,
    program: displayedProgram,
    projectDirectory,
    sequenceId,
    onController: transport.registerController,
  });
  usePlaybackShortcuts(playbackRef, project);
  const sequence = getSequence(project);
  const durationUs = sequenceDurationUs(sequence);
  const displaySize = viewerDisplaySize(sequence, stageSize, viewerScale);
  const selectedAsset = selection?.clip.assetId
    ? (project.assets.find((asset) => asset.id === selection.clip.assetId) ?? null)
    : null;

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

  async function commitTransform(kind: TransformGestureKind, transform: IrTransform) {
    if (!selection || transformCommitPending) return;
    setTransformCommitPending(true);
    await execute({
      type: "property.setMany",
      nodeId: selection.clip.id,
      updates: transformGestureUpdates(kind, transform),
      scope: "instance",
    });
    setOptimistic(null);
    setTransformCommitPending(false);
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
            ref={frameRef}
            className="relative shrink-0"
            style={{ width: displaySize.width, height: displaySize.height }}
          >
            <div className="absolute inset-0 overflow-hidden bg-black shadow-xl shadow-black/15">
              <canvas ref={canvasRef} className="block h-full w-full bg-black" />
              <ViewerGuideOverlay guides={guides} />
            </div>
            {selection && displayedTransform && (
              <ViewerTransformOverlay
                asset={selectedAsset}
                composition={selection.composition}
                disabled={transformCommitPending || runtime?.playing === true}
                displaySize={displaySize}
                frameRef={frameRef}
                transform={displayedTransform}
                onCancel={() => setOptimistic(null)}
                onPreview={(transform) =>
                  setOptimistic({ clipId: selection.clip.id, program, transform })
                }
                onCommit={(kind, transform) => {
                  setOptimistic({ clipId: selection.clip.id, program, transform });
                  void commitTransform(kind, transform);
                }}
              />
            )}
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

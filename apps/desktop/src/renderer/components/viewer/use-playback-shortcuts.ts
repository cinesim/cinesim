import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { getSequence, timeUs } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import type { PlaybackRuntime, PreviewMode } from "@cinesim/engine";
import { useRendererStoreApi } from "../../store/renderer-store-context";
import { useEditorTransport } from "../workspace/editor-transport-context";
import type { EditorTransportController } from "../workspace/editor-transport";
import { playbackShortcutAction, steppedSourceTimeUs } from "./viewer-helpers";

function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(
    target.closest('input, textarea, select, button, a[href], [role="button"], [role="menuitem"]'),
  );
}

function stepDisplayedFrame(
  playback: PlaybackRuntime,
  transport: EditorTransportController,
  project: Project,
  mode: PreviewMode | undefined,
  deltaFrames: number,
): void {
  if (mode?.kind !== "asset") {
    void transport.stepFrames(deltaFrames);
    return;
  }
  const asset = project.assets.find((candidate) => candidate.id === mode.assetId);
  if (!asset) return;
  const frameRate = asset.frameRate ?? getSequence(project).frameRate;
  playback.enterAssetPreview(
    asset.id,
    steppedSourceTimeUs(mode.sourceTimeUs, asset.durationUs, frameRate, deltaFrames),
  );
}

function goToDisplayedStart(
  playback: PlaybackRuntime,
  transport: EditorTransportController,
  mode: PreviewMode | undefined,
): void {
  if (mode?.kind === "asset") playback.enterAssetPreview(mode.assetId, timeUs(0));
  else void transport.seekTimeline(timeUs(0));
}

export function usePlaybackShortcuts(
  playbackRef: RefObject<PlaybackRuntime | null>,
  project: Project,
) {
  const projectRef = useRef(project);
  const store = useRendererStoreApi();
  const transport = useEditorTransport();

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (isInteractiveShortcutTarget(event.target)) return;
      const action = playbackShortcutAction(event);
      const playback = playbackRef.current;
      if (!action || !playback) return;
      event.preventDefault();
      const snapshot = store.getState().playbackRuntime?.snapshot;
      switch (action) {
        case "toggle-playback":
          transport.togglePlayback();
          break;
        case "shuttle-backward":
          transport.shuttle(-1);
          break;
        case "shuttle-stop":
          transport.shuttle(0);
          break;
        case "shuttle-forward":
          transport.shuttle(1);
          break;
        case "step-backward":
          stepDisplayedFrame(playback, transport, projectRef.current, snapshot?.mode, -1);
          break;
        case "step-forward":
          stepDisplayedFrame(playback, transport, projectRef.current, snapshot?.mode, 1);
          break;
        case "go-to-start":
          goToDisplayedStart(playback, transport, snapshot?.mode);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [playbackRef, store, transport]);
}

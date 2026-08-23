import { useEffect, useMemo, useState } from "react";
import { cn } from "@cinesim/ui";
import { sequenceDurationUs } from "@cinesim/core";
import type { Asset, EditorCommand, SequenceId } from "@cinesim/core";
import type { DesktopProjectSession } from "../../shared/api";
import { DebugOverlay } from "./debug-overlay";
import { EditMediaPool } from "./edit-media-pool";
import { Inspector } from "./inspector";
import { MediaBin } from "./media-bin";
import { Timeline } from "./timeline";
import { Viewer } from "./viewer";
import { useUiStore } from "../store/ui-store";

interface WorkspaceProps {
  session: DesktopProjectSession;
  section: "media" | "edit";
  activeSequenceId: string;
  mediaPoolOpen: boolean;
  onOpenTimeline: (sequenceId: string) => void;
  onSession: (session: DesktopProjectSession) => void;
}

export function Workspace({
  session,
  section,
  activeSequenceId,
  mediaPoolOpen,
  onOpenTimeline,
  onSession,
}: WorkspaceProps) {
  const [error, setError] = useState<string | null>(null);
  const selectClip = useUiStore((state) => state.selectClip);
  const setPlayheadUs = useUiStore((state) => state.setPlayheadUs);
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

  useEffect(() => {
    selectClip(null);
    setPlayheadUs(0);
  }, [activeSequence?.id, selectClip, setPlayheadUs]);

  async function command(input: EditorCommand): Promise<void> {
    setError(null);
    try {
      const response = await window.cinesim.execute(input);
      onSession(response.session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The edit could not be applied");
    }
  }

  async function importMedia(): Promise<void> {
    setError(null);
    try {
      const nextSession = await window.cinesim.importMedia();
      if (nextSession) onSession(nextSession);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The media could not be imported");
    }
  }

  async function addAsset(asset: Asset): Promise<void> {
    if (!activeSequence) return;
    const track = activeSequence.tracks.find(
      (candidate) => candidate.kind === (asset.kind === "audio" ? "audio" : "video"),
    );
    if (!track) {
      setError(`The active timeline has no ${asset.kind === "audio" ? "audio" : "video"} track`);
      return;
    }
    await command({
      type: "clip.add",
      trackId: track.id,
      assetId: asset.id,
      timelineStartUs: sequenceDurationUs(activeSequence),
    });
  }

  return (
    <div className="relative h-full min-h-0 bg-canvas">
      {section === "media" ? (
        <MediaBin project={session.project} onSession={onSession} onOpenTimeline={onOpenTimeline} />
      ) : activeSequence ? (
        <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_288px]">
          <div
            className={cn(
              "grid min-h-0",
              mediaPoolOpen
                ? "grid-cols-[248px_minmax(320px,1fr)_260px]"
                : "grid-cols-[minmax(440px,1fr)_284px]",
            )}
          >
            {mediaPoolOpen && (
              <EditMediaPool project={editorProject} onAddAsset={addAsset} onImport={importMedia} />
            )}
            <Viewer key={activeSequence.id} project={editorProject} />
            <Inspector project={editorProject} />
          </div>
          <Timeline project={editorProject} onCommand={command} />
        </div>
      ) : null}

      <DebugOverlay />
      {error && (
        <button
          className="absolute bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-border-strong bg-panel px-4 py-2 text-ui text-primary shadow-xl"
          onClick={() => setError(null)}
        >
          {error}
        </button>
      )}
    </div>
  );
}

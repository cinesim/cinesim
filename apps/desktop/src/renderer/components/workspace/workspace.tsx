import { useEffect, useMemo } from "react";
import { timeUs } from "@cinesim/core";
import type { SequenceId } from "@cinesim/core";
import type { CutLayoutState, DesktopProjectSession, EditorLayoutState } from "../../../shared/api";
import { useRendererStore } from "../../store/renderer-store-context";
import { MediaBin } from "../media/media-bin";
import { CutWorkspace } from "./cut-workspace";
import { EditWorkspace } from "./edit-workspace";

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
  const error = useRendererStore((state) => state.operationError);
  const clearError = useRendererStore((state) => state.clearError);
  const transcripts = useRendererStore((state) => state.transcripts);
  const loadTranscripts = useRendererStore((state) => state.loadTranscripts);
  const selectClip = useRendererStore((state) => state.selectClip);
  const setPlayheadUs = useRendererStore((state) => state.setPlayheadUs);
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
    setPlayheadUs(timeUs(0));
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

  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden bg-canvas">
      {section === "media" ? (
        <MediaBin project={session.project} onOpenTimeline={onOpenTimeline} />
      ) : activeSequence ? (
        section === "cut" ? (
          <CutWorkspace
            session={session}
            project={editorProject}
            sequenceId={activeSequence.id}
            initialLayout={cutLayout}
          />
        ) : (
          <EditWorkspace
            session={session}
            project={editorProject}
            sequenceId={activeSequence.id}
            initialLayout={editorLayout}
            mediaPoolOpen={mediaPoolOpen}
            inspectorOpen={inspectorOpen}
            notesOpen={notesOpen}
          />
        )
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

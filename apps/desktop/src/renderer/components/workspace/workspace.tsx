import { useEffect, useMemo } from "react";
import { timeUs } from "@cinesim/core";
import type { SequenceId } from "@cinesim/core";
import type { DesktopProjectSession } from "../../../shared/contracts";
import {
  cutLayoutFromState,
  editorLayoutFromState,
  sessionFromLifecycle,
} from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { MediaBin } from "../media/media-bin";
import { CutWorkspace } from "./cut-workspace";
import { EditorTransportProvider } from "./editor-transport-context";
import { EditWorkspace } from "./edit-workspace";

interface WorkspaceProps {
  session: DesktopProjectSession;
}

export function Workspace() {
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  return session ? <ProjectWorkspace key={session.directory} session={session} /> : null;
}

function ProjectWorkspace({ session }: WorkspaceProps) {
  const section = useRendererStore((state) => state.projectSection);
  const activeSequenceId = useRendererStore(
    (state) => state.activeSequenceId ?? session.project.activeSequenceId,
  );
  const mediaPoolOpen = useRendererStore((state) => state.mediaPoolOpen);
  const inspectorOpen = useRendererStore((state) => state.inspectorOpen);
  const notesOpen = useRendererStore((state) => state.notesOpen);
  const editorLayout = useRendererStore(editorLayoutFromState);
  const cutLayout = useRendererStore(cutLayoutFromState);
  const onOpenTimeline = useRendererStore((state) => state.showTimeline);
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
      {session.diagnostics.length > 0 && (
        <div
          className="absolute inset-x-3 top-3 z-50 max-h-32 overflow-y-auto rounded border border-red-500/40 bg-red-950/95 px-3 py-2 shadow-lg"
          role="alert"
        >
          <p className="text-ui-xs font-medium text-red-100">
            Source has {session.diagnostics.length} compiler diagnostic
            {session.diagnostics.length === 1 ? "" : "s"}; the last valid preview remains active.
          </p>
          {session.diagnostics.slice(0, 3).map((diagnostic, index) => (
            <p
              key={`${diagnostic.code}-${diagnostic.source?.uri ?? "project"}-${index}`}
              className="mt-1 text-[11px] text-red-200"
            >
              {diagnostic.code}: {diagnostic.message}
              {diagnostic.source
                ? ` · ${diagnostic.source.uri}:${diagnostic.source.start.line}:${diagnostic.source.start.column}`
                : ""}
            </p>
          ))}
        </div>
      )}
      {section === "media" ? (
        <MediaBin project={session.project} onOpenTimeline={onOpenTimeline} />
      ) : activeSequence ? (
        <EditorTransportProvider key={activeSequence.id}>
          {section === "cut" ? (
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
          )}
        </EditorTransportProvider>
      ) : null}
    </div>
  );
}

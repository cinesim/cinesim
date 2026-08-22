import { useCallback, useEffect, useMemo, useState } from "react";
import { Film, Library, X } from "lucide-react";
import { cn } from "@cinesim/ui";
import type { EditorCommand, SequenceId } from "@cinesim/core";
import type { DesktopAppState, DesktopProjectSession, ProjectViewState } from "../../shared/api";
import { DebugOverlay } from "./debug-overlay";
import { Inspector } from "./inspector";
import { MediaBin } from "./media-bin";
import { Timeline } from "./timeline";
import { Viewer } from "./viewer";

interface WorkspaceProps {
  session: DesktopProjectSession;
  initialView: ProjectViewState | undefined;
  onSession: (session: DesktopProjectSession) => void;
  onAppState: (state: DesktopAppState) => void;
}

function validInitialView(
  session: DesktopProjectSession,
  initial?: ProjectViewState,
): ProjectViewState {
  const sequenceIds = new Set<string>(session.project.sequences.map((sequence) => sequence.id));
  const openSequenceIds = (initial?.openSequenceIds ?? []).filter((id) => sequenceIds.has(id));
  const activeTab =
    initial?.activeTab === "media" ||
    (typeof initial?.activeTab === "string" && openSequenceIds.includes(initial.activeTab))
      ? initial.activeTab
      : "media";
  return { openSequenceIds, activeTab };
}

export function Workspace({ session, initialView, onSession, onAppState }: WorkspaceProps) {
  const [view, setView] = useState(() => validInitialView(session, initialView));
  const [error, setError] = useState<string | null>(null);
  const activeSequence =
    view.activeTab === "media"
      ? null
      : (session.project.sequences.find((sequence) => sequence.id === view.activeTab) ?? null);
  const editorProject = useMemo(
    () =>
      activeSequence
        ? { ...session.project, activeSequenceId: activeSequence.id as SequenceId }
        : session.project,
    [activeSequence, session.project],
  );

  const updateView = useCallback(
    async (next: ProjectViewState): Promise<void> => {
      setView(next);
      try {
        onAppState(await window.cinesim.setProjectView(next));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The open tabs could not be saved");
      }
    },
    [onAppState],
  );

  function openTimeline(sequenceId: string) {
    const openSequenceIds = view.openSequenceIds.includes(sequenceId)
      ? view.openSequenceIds
      : [...view.openSequenceIds, sequenceId];
    void updateView({ openSequenceIds, activeTab: sequenceId });
  }

  const closeTimeline = useCallback(
    (sequenceId: string) => {
      const openSequenceIds = view.openSequenceIds.filter((id) => id !== sequenceId);
      const activeTab = view.activeTab === sequenceId ? "media" : view.activeTab;
      void updateView({ openSequenceIds, activeTab });
    },
    [updateView, view.activeTab, view.openSequenceIds],
  );

  useEffect(
    () =>
      window.cinesim.onCloseActiveTab(() => {
        if (view.activeTab !== "media") closeTimeline(view.activeTab);
      }),
    [closeTimeline, view.activeTab],
  );

  async function command(input: EditorCommand): Promise<void> {
    setError(null);
    try {
      const response = await window.cinesim.execute(input);
      onSession(response.session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The edit could not be applied");
    }
  }

  return (
    <div className="relative grid h-full min-h-0 grid-rows-[40px_minmax(0,1fr)] bg-canvas">
      <nav
        className="flex min-w-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-panel px-3"
        aria-label="Project tabs"
      >
        <button
          className={cn(
            "relative flex h-full shrink-0 items-center gap-2 px-2 text-ui transition-colors after:pointer-events-none after:absolute after:inset-x-0 after:bottom-[-1px] after:z-10 after:h-0.5",
            view.activeTab === "media"
              ? "text-primary after:bg-primary"
              : "text-muted after:bg-transparent hover:text-primary",
          )}
          aria-current={view.activeTab === "media" ? "page" : undefined}
          onClick={() => void updateView({ ...view, activeTab: "media" })}
        >
          <Library size={14} /> Media
        </button>
        {view.openSequenceIds.map((sequenceId) => {
          const sequence = session.project.sequences.find(
            (candidate) => candidate.id === sequenceId,
          );
          if (!sequence) return null;
          return (
            <div
              key={sequence.id}
              className={cn(
                "group relative flex h-full shrink-0 items-center transition-colors after:pointer-events-none after:absolute after:inset-x-0 after:bottom-[-1px] after:z-10 after:h-0.5",
                view.activeTab === sequence.id
                  ? "text-primary after:bg-primary"
                  : "text-muted after:bg-transparent hover:text-primary",
              )}
              aria-current={view.activeTab === sequence.id ? "page" : undefined}
            >
              <button
                className="flex h-full min-w-0 items-center gap-2 pl-3 pr-2 text-ui"
                onClick={() => void updateView({ ...view, activeTab: sequence.id })}
              >
                <Film size={14} />
                <span className="max-w-44 truncate">{sequence.name}</span>
              </button>
              <button
                className="mr-1 grid size-6 place-items-center rounded text-muted opacity-60 hover:bg-surface-hover hover:text-primary group-hover:opacity-100"
                aria-label={`Close ${sequence.name}`}
                onClick={() => closeTimeline(sequence.id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </nav>

      {view.activeTab === "media" ? (
        <MediaBin project={session.project} onSession={onSession} onOpenTimeline={openTimeline} />
      ) : activeSequence ? (
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_288px]">
          <div className="grid min-h-0 grid-cols-[minmax(440px,1fr)_284px]">
            <Viewer project={editorProject} />
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

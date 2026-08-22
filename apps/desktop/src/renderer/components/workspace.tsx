import { useState } from "react";
import type { EditorCommand } from "@cinesim/core";
import type { DesktopProjectSession } from "../../shared/api";
import { DebugOverlay } from "./debug-overlay";
import { Inspector } from "./inspector";
import { MediaBin } from "./media-bin";
import { Timeline } from "./timeline";
import { TopBar } from "./top-bar";
import { Viewer } from "./viewer";

interface WorkspaceProps {
  session: DesktopProjectSession;
  onSession: (session: DesktopProjectSession) => void;
}

export function Workspace({ session, onSession }: WorkspaceProps) {
  const [error, setError] = useState<string | null>(null);

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
    <main className="relative grid h-screen grid-rows-[48px_minmax(0,1fr)_288px] overflow-hidden bg-[#09090b] text-zinc-100">
      <TopBar session={session} onSession={onSession} />
      <div className="grid min-h-0 grid-cols-[260px_minmax(440px,1fr)_284px]">
        <MediaBin project={session.project} onSession={onSession} />
        <Viewer project={session.project} />
        <Inspector project={session.project} />
      </div>
      <Timeline project={session.project} onCommand={command} />
      <DebugOverlay />
      {error && (
        <button
          className="absolute bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-red-400/20 bg-red-950/90 px-4 py-2 text-xs text-red-200 shadow-xl"
          onClick={() => setError(null)}
        >
          {error}
        </button>
      )}
    </main>
  );
}

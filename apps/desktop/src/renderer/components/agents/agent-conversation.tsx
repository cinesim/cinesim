import { useEffect, useRef, useState } from "react";
import type { AgentSessionSnapshot } from "../../../shared/contracts";
import { AgentEventView } from "./agent-event-view";
import { formatRunningDuration, turnStartedAt } from "./agent-event-format";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function AgentConversation({ session }: { session: AgentSessionSnapshot }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const eventCount = session.events.length;
  const lastEventText = session.events.at(-1)?.text;
  const running = session.status === "starting" || session.status === "working";

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [eventCount, lastEventText]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running, session.activeTurnId]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-14 pt-3">
      {eventCount > 0 && (
        <div className="space-y-2.5">
          {session.events.map((event) => (
            <AgentEventView key={event.id} event={event} session={session} />
          ))}
          {running && session.activeTurnId && (
            <div
              className="flex items-center gap-2 px-1 py-1 font-mono text-ui text-muted"
              aria-label={`Agent working for ${formatRunningDuration(turnStartedAt(session, session.activeTurnId), now)}`}
            >
              <span className="w-4 text-center" aria-hidden="true">
                {SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length]}
              </span>
              <span className="tabular-nums">
                {formatRunningDuration(turnStartedAt(session, session.activeTurnId), now)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

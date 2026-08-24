import { useEffect, useRef } from "react";
import type { AgentSessionSnapshot } from "../../shared/api";
import { AgentEventView } from "./agent-event-view";

interface AgentConversationProps {
  session: AgentSessionSnapshot;
  onApproval: (requestId: string, decision: "accept" | "decline") => void;
  onRevert: (turnId: string) => void;
}

export function AgentConversation({ session, onApproval, onRevert }: AgentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventCount = session.events.length;
  const lastEventText = session.events.at(-1)?.text;

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [eventCount, lastEventText]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-14 pt-3">
      {eventCount > 0 && (
        <div className="space-y-2.5">
          {session.events.map((event) => (
            <AgentEventView
              key={event.id}
              event={event}
              session={session}
              onApproval={onApproval}
              onRevert={onRevert}
            />
          ))}
        </div>
      )}
    </div>
  );
}

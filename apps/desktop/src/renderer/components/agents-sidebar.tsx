import { Bot } from "lucide-react";

export function AgentsSidebar() {
  return (
    <div className="grid h-full min-h-48 place-items-center p-5 text-center">
      <div>
        <span className="mx-auto grid size-9 place-items-center rounded-lg border border-border bg-panel-muted text-muted">
          <Bot size={17} />
        </span>
        <p className="mt-3 text-ui font-medium text-primary">No active agents</p>
        <p className="mt-1 text-ui-xs leading-4 text-muted">
          Agents working on this project will appear here.
        </p>
      </div>
    </div>
  );
}

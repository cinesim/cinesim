import {
  Brain,
  CircleAlert,
  Copy,
  FilePenLine,
  FileSearch,
  Film,
  FolderSearch,
  Image as ImageIcon,
  ListTree,
  ListVideo,
  Move,
  Plus,
  Scissors,
  Search,
  Terminal,
  Trash2,
  Wrench,
} from "@cinesim/ui";
import ReactMarkdown from "react-markdown";
import { cn, Notice } from "@cinesim/ui";
import type { AgentEvent, AgentSessionSnapshot } from "../../../shared/contracts";
import { formatTurnClock, formatTurnDuration, turnStartedAt } from "./agent-event-format";

interface AgentEventViewProps {
  event: AgentEvent;
  session: AgentSessionSnapshot;
}

function UserMessage({ event }: Pick<AgentEventViewProps, "event">) {
  return (
    <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-surface px-3 py-2 text-ui leading-5 text-primary">
      {event.text}
    </div>
  );
}

function AssistantMessage({ event }: Pick<AgentEventViewProps, "event">) {
  return (
    <div className="min-w-0 px-1 text-ui leading-5 text-primary [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-secondary [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-ui-xs [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-ui-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-ui [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        components={{
          a: ({ children, href }) => (
            <a
              className="text-secondary underline decoration-border-strong underline-offset-2 hover:text-primary"
              href={href}
              rel="noreferrer"
              target="_blank"
            >
              {children}
            </a>
          ),
        }}
      >
        {event.text}
      </ReactMarkdown>
    </div>
  );
}

function ReasoningEvent({ event }: Pick<AgentEventViewProps, "event">) {
  return (
    <div className="px-1 py-1 text-muted">
      <div className="flex items-center gap-2 text-ui">
        <Brain size={15} />
        <span className="font-medium text-secondary">Thinking</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-ui leading-6">{event.text}</p>
    </div>
  );
}

function TurnResultEvent({ event, session }: AgentEventViewProps) {
  const completedAt = Date.parse(event.createdAt);
  const startedAt = turnStartedAt(session, event.turnId);
  const lastAssistantMessage = session.events.findLast(
    (candidate) => candidate.turnId === event.turnId && candidate.kind === "assistant-message",
  );
  return (
    <div className="space-y-2 px-1 py-1 text-muted">
      {event.status !== "completed" && (
        <div
          className={cn(
            "w-fit rounded-md border px-2 py-1 font-mono text-ui-xs uppercase tracking-wider",
            event.status === "failed"
              ? "border-danger/40 text-danger"
              : "border-border-strong text-secondary",
          )}
        >
          {event.status === "failed" ? "Turn failed" : "Interrupted by user"}
        </div>
      )}
      {event.status === "failed" && event.detail && (
        <p className="break-words text-ui-xs leading-4 text-muted">{event.detail}</p>
      )}
      <div className="flex items-center gap-2 text-ui-xs tabular-nums">
        <span>{formatTurnDuration(startedAt, completedAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatTurnClock(event.createdAt)}</span>
        {event.status === "completed" && lastAssistantMessage?.text && (
          <button
            className="ml-1 grid size-5 place-items-center rounded text-muted hover:bg-surface hover:text-primary"
            aria-label="Copy response"
            title="Copy response"
            onClick={() => void navigator.clipboard.writeText(lastAssistantMessage.text ?? "")}
          >
            <Copy size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function ToolEvent({ event }: Pick<AgentEventViewProps, "event">) {
  const detail = event.detail?.trim();
  const showDetail = detail && !["completed", "running"].includes(detail.toLowerCase());
  const toolTitle = event.title ?? event.toolName ?? "Tool";
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-ui text-muted",
        event.status === "running" && "bg-surface/60",
      )}
    >
      {event.status === "running" ? (
        <span className="w-4 shrink-0 text-center font-mono text-secondary">+</span>
      ) : event.status === "failed" ? (
        <CircleAlert size={14} className="w-4 shrink-0 text-muted" />
      ) : (
        <ToolEventIcon toolName={event.toolName} title={toolTitle} />
      )}
      <span className="shrink-0 text-secondary">{toolEventLabel(event.toolName ?? toolTitle)}</span>
      {showDetail && (
        <span
          className="min-w-0 truncate rounded-sm bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-muted"
          title={detail}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

function NoticeEvent({ event }: Pick<AgentEventViewProps, "event">) {
  return (
    <Notice className={cn(event.kind !== "error" && "border-0 bg-transparent text-muted")}>
      {event.title && <p className="font-medium text-secondary">{event.title}</p>}
      {event.detail && <p className="break-words">{event.detail}</p>}
    </Notice>
  );
}

export function AgentEventView(props: AgentEventViewProps) {
  const { event } = props;
  switch (event.kind) {
    case "user-message":
      return <UserMessage event={event} />;
    case "assistant-message":
      return <AssistantMessage event={event} />;
    case "reasoning":
      return <ReasoningEvent event={event} />;
    case "turn-result":
      return <TurnResultEvent {...props} />;
    case "tool-started":
    case "tool-completed":
      return <ToolEvent event={event} />;
    default:
      return <NoticeEvent event={event} />;
  }
}

function ToolEventIcon({ toolName, title }: { toolName: string | undefined; title: string }) {
  const normalized = (toolName ?? title).toLowerCase().replaceAll(/[-_\s]/g, "");
  const Icon =
    TOOL_ICON_RULES.find((rule) => rule.matches.some((value) => normalized.includes(value)))
      ?.icon ?? Wrench;
  return <Icon size={13} className="shrink-0" />;
}

const TOOL_ICON_RULES = [
  { matches: ["projectinspect"], icon: FolderSearch },
  { matches: ["timeline"], icon: ListTree },
  { matches: ["assetslist"], icon: ListVideo },
  { matches: ["assetinspect"], icon: FileSearch },
  { matches: ["filmstrip"], icon: Film },
  { matches: ["frame"], icon: ImageIcon },
  { matches: ["clipadd"], icon: Plus },
  { matches: ["clipmove"], icon: Move },
  { matches: ["cliptrim", "clipsplit"], icon: Scissors },
  { matches: ["clipdelete"], icon: Trash2 },
  { matches: ["filechange", "edit"], icon: FilePenLine },
  { matches: ["command", "shell", "bash"], icon: Terminal },
  { matches: ["search"], icon: Search },
] as const;

function toolEventLabel(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/[-_\s]/g, "");
  if (normalized.includes("command") || normalized.includes("shell") || normalized.includes("bash"))
    return "Bash";
  if (normalized.includes("filechange")) return "Edit";
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FilePenLine,
  FileSearch,
  Film,
  FolderSearch,
  Image as ImageIcon,
  ListTree,
  ListVideo,
  Move,
  Plus,
  RotateCcw,
  Scissors,
  Search,
  Terminal,
  Trash2,
  Wrench,
} from "@cinesim/ui";
import ReactMarkdown from "react-markdown";
import { cn, Notice } from "@cinesim/ui";
import type { AgentEvent, AgentSessionSnapshot } from "../../../shared/contracts";

interface AgentEventViewProps {
  event: AgentEvent;
  session: AgentSessionSnapshot;
  onApproval: (requestId: string, decision: "accept" | "decline") => void;
  onRevert: (turnId: string) => void;
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
    <details className="group rounded-lg border border-border bg-panel-muted">
      <summary className="flex list-none items-center gap-2 px-2.5 py-2 text-ui-xs text-muted">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" /> Thinking
      </summary>
      <p className="whitespace-pre-wrap border-t border-border px-3 py-2 text-ui-xs leading-4 text-muted">
        {event.text}
      </p>
    </details>
  );
}

function ApprovalEvent({ event, session, onApproval }: Omit<AgentEventViewProps, "onRevert">) {
  const resolution = session.events.find(
    (candidate) =>
      candidate.kind === "approval-resolved" && candidate.requestId === event.requestId,
  );
  if (resolution) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-ui-xs text-muted">
        <Check size={12} /> {resolution.title}: {event.title}
      </div>
    );
  }
  const requestId = event.requestId!;
  return (
    <div className="rounded-lg border border-border-strong bg-panel p-3">
      <div className="flex items-start gap-2">
        <CircleAlert size={14} className="mt-0.5 shrink-0 text-secondary" />
        <div className="min-w-0">
          <p className="text-ui font-medium text-primary">{event.title}</p>
          <p className="mt-1 break-words text-ui-xs leading-4 text-muted">{event.detail}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          className="h-7 rounded-md border border-border px-2.5 text-ui-xs text-secondary hover:bg-surface hover:text-primary"
          onClick={() => onApproval(requestId, "decline")}
        >
          Decline
        </button>
        <button
          className="h-7 rounded-md bg-accent px-2.5 text-ui-xs text-on-accent hover:bg-accent-hover"
          onClick={() => onApproval(requestId, "accept")}
        >
          Allow once
        </button>
      </div>
    </div>
  );
}

function CheckpointEvent({ event, session, onRevert }: Omit<AgentEventViewProps, "onApproval">) {
  const checkpoint = session.checkpoints.find((candidate) => candidate.turnId === event.turnId);
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-ui-xs text-muted">
      <Clock3 size={13} className="shrink-0" />
      <p className="min-w-0 flex-1 truncate" title={event.detail ?? event.title}>
        <span className="font-medium text-secondary">{event.title}</span>
        {event.detail && <span> · {event.detail}</span>}
      </p>
      {checkpoint && (
        <button
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary"
          aria-label="Revert turn"
          title="Revert this turn"
          onClick={() => onRevert(checkpoint.turnId)}
        >
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

function ToolStatus({ status }: { status: AgentEvent["status"] }) {
  if (status === "running") {
    return <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted" />;
  }
  return status === "failed" ? (
    <CircleAlert size={12} className="shrink-0 text-muted" />
  ) : (
    <Check size={12} className="shrink-0 text-muted" />
  );
}

function ToolEvent({ event }: Pick<AgentEventViewProps, "event">) {
  const detail = event.detail?.trim();
  const showDetail = detail && !["completed", "running"].includes(detail.toLowerCase());
  const toolTitle = event.title ?? event.toolName ?? "Tool";
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-ui-xs text-muted">
      <ToolEventIcon toolName={event.toolName} title={toolTitle} />
      <span className="shrink-0 font-medium text-secondary">
        {toolEventLabel(event.toolName ?? toolTitle)}
      </span>
      {showDetail && (
        <span
          className="min-w-0 truncate rounded bg-surface px-1.5 py-0.5 text-disabled"
          title={detail}
        >
          {detail}
        </span>
      )}
      <span className="min-w-0 flex-1" />
      <ToolStatus status={event.status} />
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
    case "approval-requested":
      return event.requestId ? <ApprovalEvent {...props} /> : <NoticeEvent event={event} />;
    case "checkpoint":
      return <CheckpointEvent {...props} />;
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

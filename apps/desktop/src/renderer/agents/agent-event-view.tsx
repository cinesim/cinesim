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
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { cn, Notice } from "@cinesim/ui";
import type { AgentEvent, AgentSessionSnapshot } from "../../shared/api";

export function AgentEventView({
  event,
  session,
  onApproval,
  onRevert,
}: {
  event: AgentEvent;
  session: AgentSessionSnapshot;
  onApproval: (requestId: string, decision: "accept" | "decline") => void;
  onRevert: (turnId: string) => void;
}) {
  if (event.kind === "user-message")
    return (
      <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-surface px-3 py-2 text-ui leading-5 text-primary">
        {event.text}
      </div>
    );
  if (event.kind === "assistant-message")
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
  if (event.kind === "reasoning")
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
  if (event.kind === "approval-requested" && event.requestId) {
    const resolution = session.events.find(
      (candidate) =>
        candidate.kind === "approval-resolved" && candidate.requestId === event.requestId,
    );
    if (resolution)
      return (
        <div className="flex items-center gap-2 px-2 py-1 text-ui-xs text-muted">
          <Check size={12} /> {resolution.title}: {event.title}
        </div>
      );
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
            onClick={() => onApproval(event.requestId!, "decline")}
          >
            Decline
          </button>
          <button
            className="h-7 rounded-md bg-accent px-2.5 text-ui-xs text-on-accent hover:bg-accent-hover"
            onClick={() => onApproval(event.requestId!, "accept")}
          >
            Allow once
          </button>
        </div>
      </div>
    );
  }
  if (event.kind === "checkpoint") {
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
  if (event.kind === "tool-started" || event.kind === "tool-completed") {
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
        {event.status === "running" ? (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted" />
        ) : event.status === "failed" ? (
          <CircleAlert size={12} className="shrink-0 text-muted" />
        ) : (
          <Check size={12} className="shrink-0 text-muted" />
        )}
      </div>
    );
  }
  return (
    <Notice className={cn(event.kind !== "error" && "border-0 bg-transparent text-muted")}>
      {event.title && <p className="font-medium text-secondary">{event.title}</p>}
      {event.detail && <p className="break-words">{event.detail}</p>}
    </Notice>
  );
}

function ToolEventIcon({ toolName, title }: { toolName: string | undefined; title: string }) {
  const normalized = (toolName ?? title).toLowerCase().replaceAll(/[-_\s]/g, "");
  const Icon = normalized.includes("projectinspect")
    ? FolderSearch
    : normalized.includes("timeline")
      ? ListTree
      : normalized.includes("assetslist")
        ? ListVideo
        : normalized.includes("assetinspect")
          ? FileSearch
          : normalized.includes("filmstrip")
            ? Film
            : normalized.includes("frame")
              ? ImageIcon
              : normalized.includes("clipadd")
                ? Plus
                : normalized.includes("clipmove")
                  ? Move
                  : normalized.includes("cliptrim") || normalized.includes("clipsplit")
                    ? Scissors
                    : normalized.includes("clipdelete")
                      ? Trash2
                      : normalized.includes("filechange") || normalized.includes("edit")
                        ? FilePenLine
                        : normalized.includes("command") ||
                            normalized.includes("shell") ||
                            normalized.includes("bash")
                          ? Terminal
                          : normalized.includes("search")
                            ? Search
                            : Wrench;
  return <Icon size={13} className="shrink-0" />;
}

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

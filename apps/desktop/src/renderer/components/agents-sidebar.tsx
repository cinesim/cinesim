import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { cn } from "@cinesim/ui";
import type {
  AgentProviderKind,
  AgentProviderStatus,
  AgentSessionSnapshot,
  DesktopProjectSession,
} from "../../shared/api";
import { formatTimecode } from "../lib/format";
import { AGENT_PROVIDER_KINDS, providerLabel } from "../agents/provider-catalog";
import { AgentComposer } from "../agents/agent-composer";
import { AgentConversation } from "../agents/agent-conversation";
import { useAgentProjectController } from "../agents/use-agent-project-controller";
import { ProviderIcon } from "./provider-icon";

interface AgentsSidebarProps {
  session: DesktopProjectSession;
  onConfigure: () => void;
}

export function AgentsSidebar({ session, onConfigure }: AgentsSidebarProps) {
  const {
    snapshot,
    settings,
    providers,
    activeSession,
    activeSequenceId,
    playheadUs,
    composer,
    setComposer,
    creating,
    setCreating,
    busy,
    error,
    create,
    sendMessage,
    updateActiveSession,
    selectAgent,
    deleteAgent,
    interruptAgent,
    respondApproval,
    revertTurn,
  } = useAgentProjectController(session);
  const availableProviders = providers.filter((provider) => provider.state === "connected");
  if (!snapshot || !settings) return <AgentsLoadingState error={error} />;
  const agentRunning =
    activeSession?.status === "starting" ||
    activeSession?.status === "working" ||
    activeSession?.status === "waiting";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-border px-2.5">
        {activeSession ? (
          <details className="sidebar-project-menu min-w-0 flex-1">
            <summary className="flex h-8 list-none items-center gap-2 rounded-md px-2 text-ui hover:bg-surface">
              <StatusDot status={activeSession.status} />
              <span className="min-w-0 flex-1 truncate font-medium">{activeSession.title}</span>
              <ChevronDown size={13} className="text-muted" />
            </summary>
            <div className="absolute left-2 right-12 top-12 z-30 max-h-64 overflow-y-auto rounded-lg border border-border bg-panel p-1 shadow-xl shadow-black/15">
              {snapshot.sessions.map((agent) => (
                <button
                  key={agent.id}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui hover:bg-surface",
                    agent.id === activeSession.id && "bg-surface",
                  )}
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    void selectAgent(agent.id);
                  }}
                >
                  <StatusDot status={agent.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-primary">{agent.title}</span>
                    <span className="block text-ui-xs text-muted">
                      {providerLabel(agent.provider)} · {agent.model}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </details>
        ) : (
          <span className="min-w-0 flex-1 px-2 text-ui text-muted">No agent selected</span>
        )}
        {activeSession && (
          <button
            className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary"
            aria-label="Delete agent"
            title="Delete agent"
            onClick={() => {
              if (!window.confirm(`Delete “${activeSession.title}”?`)) return;
              void deleteAgent(activeSession.id);
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
        <button
          className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary"
          aria-label="New agent"
          title="New agent"
          onClick={() => setCreating((open) => !open)}
        >
          <Plus size={15} />
        </button>
        {creating && (
          <div className="absolute right-2 top-12 z-40 w-52 rounded-lg border border-border bg-panel p-1 shadow-xl shadow-black/15">
            {AGENT_PROVIDER_KINDS.map((provider) => {
              const status = providers.find((candidate) => candidate.provider === provider);
              return (
                <button
                  key={provider}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui hover:bg-surface disabled:opacity-50"
                  disabled={status?.state !== "connected" || busy}
                  onClick={() => void create(provider)}
                >
                  <ProviderIcon provider={provider} className="shrink-0 text-muted" />
                  <span className="flex-1">{providerLabel(provider)}</span>
                  {status?.state === "connected" ? (
                    <Check size={13} className="text-emerald-500" />
                  ) : (
                    <CircleAlert size={13} className="text-muted" />
                  )}
                </button>
              );
            })}
            {availableProviders.length === 0 && (
              <button
                className="mt-1 flex w-full items-center gap-2 border-t border-border px-2 py-2 text-left text-ui text-secondary hover:text-primary"
                onClick={onConfigure}
              >
                <Settings size={14} /> Configure agents…
              </button>
            )}
          </div>
        )}
      </div>

      {!activeSession ? (
        <EmptyAgentState
          providers={providers}
          defaultProvider={settings.defaultProvider}
          busy={busy}
          error={error}
          onCreate={(provider) => void create(provider)}
          onConfigure={onConfigure}
        />
      ) : (
        <>
          <AgentConversation
            session={activeSession}
            onApproval={(requestId, decision) =>
              void respondApproval(activeSession.id, requestId, decision)
            }
            onRevert={(turnId) => void revertTurn(activeSession.id, turnId)}
          />
          {error && (
            <p className="mx-3 mb-2 rounded-md border border-border bg-panel-muted px-2.5 py-2 text-ui-xs text-secondary">
              {error}
            </p>
          )}
          <AgentComposer
            session={activeSession}
            value={composer}
            busy={busy}
            running={agentRunning}
            defaultModel={settings.providers[activeSession.provider].model}
            playheadLabel={formatTimecode(
              playheadUs,
              session.project.sequences.find((sequence) => sequence.id === activeSequenceId)
                ?.frameRate,
            )}
            onValueChange={setComposer}
            onSend={() => void sendMessage()}
            onStop={() => void interruptAgent(activeSession.id)}
            onUpdate={(update) => void updateActiveSession(update)}
            onConfigure={onConfigure}
          />
        </>
      )}
    </div>
  );
}

function AgentsLoadingState({ error }: { error: string | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={!error}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="size-2 animate-pulse rounded-full bg-surface-active" />
        <span className="h-3 w-28 animate-pulse rounded bg-surface-active" />
        <span className="min-w-0 flex-1" />
        <span className="size-7 animate-pulse rounded-md bg-surface" />
        <span className="size-7 animate-pulse rounded-md bg-surface" />
      </div>

      <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
        {error ? (
          <div className="flex max-w-64 items-start gap-2 text-ui-xs leading-4 text-muted">
            <CircleAlert size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : (
          <output className="flex items-center gap-2 text-ui-xs text-muted">
            <span className="size-1.5 animate-pulse rounded-full bg-muted" />
            <span>Setting up agent…</span>
          </output>
        )}
      </div>

      <div className="relative z-10 shrink-0 bg-canvas p-3">
        <div
          className="pointer-events-none absolute inset-x-0 -top-14 h-14 bg-linear-to-b from-transparent via-canvas/80 to-canvas"
          aria-hidden="true"
        />
        <div className="rounded-xl border border-border bg-canvas p-2.5 opacity-60 shadow-sm shadow-black/5">
          <textarea
            className="block min-h-24 w-full resize-none bg-transparent px-1 py-0.5 text-ui leading-5 text-disabled outline-none placeholder:text-disabled"
            aria-label="Agent input is loading"
            disabled
            placeholder="Agent input will be ready shortly…"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-16 animate-pulse rounded bg-surface-active" />
              <span className="h-2.5 w-10 animate-pulse rounded bg-surface" />
            </div>
            <div className="flex items-center gap-2">
              <span className="size-4 animate-pulse rounded-full border border-border-strong" />
              <button
                className="grid size-7 place-items-center rounded-md bg-surface text-disabled"
                aria-label="Send message"
                disabled
              >
                <ArrowUp size={15} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
        <p className="mt-1.5 text-center text-[10px] leading-3 text-disabled">
          Agents can make mistakes. Review checkpoint changes before continuing.
        </p>
      </div>
    </div>
  );
}

function EmptyAgentState({
  providers,
  defaultProvider,
  busy,
  error,
  onCreate,
  onConfigure,
}: {
  providers: AgentProviderStatus[];
  defaultProvider: AgentProviderKind;
  busy: boolean;
  error: string | null;
  onCreate: (provider: AgentProviderKind) => void;
  onConfigure: () => void;
}) {
  const connected = providers.filter((provider) => provider.state === "connected");
  const preferred =
    connected.find((provider) => provider.provider === defaultProvider) ?? connected[0];
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-5 text-center">
      <div className="max-w-56">
        <span className="mx-auto grid size-10 place-items-center rounded-xl border border-border bg-panel-muted text-muted">
          {preferred ? <ProviderIcon provider={preferred.provider} size={18} /> : <Bot size={18} />}
        </span>
        <p className="mt-3 text-ui font-medium text-primary">
          {preferred ? "Start a project agent" : "Configure an agent provider"}
        </p>
        <p className="mt-1 text-ui-xs leading-4 text-muted">
          {preferred
            ? `${providerLabel(preferred.provider)} will work with the open Cinesim project through validated tools.`
            : "Cinesim could not find a connected Claude Code or Codex installation."}
        </p>
        {error && (
          <p className="mt-3 rounded-md border border-border bg-panel-muted px-2.5 py-2 text-ui-xs leading-4 text-secondary">
            {error}
          </p>
        )}
        {preferred ? (
          <button
            className="mt-4 h-8 rounded-md bg-accent px-3 text-ui font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
            disabled={busy}
            onClick={() => onCreate(preferred.provider)}
          >
            New {providerLabel(preferred.provider)} agent
          </button>
        ) : (
          <button
            className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border border-border bg-panel px-3 text-ui text-primary hover:bg-surface"
            onClick={onConfigure}
          >
            <Settings size={14} /> Open agent settings
          </button>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: AgentSessionSnapshot["status"] }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "working" || status === "starting"
          ? "animate-pulse bg-emerald-500"
          : status === "waiting"
            ? "bg-amber-500"
            : status === "failed"
              ? "bg-red-500"
              : "bg-disabled",
      )}
    />
  );
}

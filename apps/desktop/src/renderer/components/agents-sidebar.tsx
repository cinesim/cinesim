import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Gauge,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";
import { cn } from "@cinesim/ui";
import type {
  AgentEvent,
  AgentEffort,
  AgentProjectSnapshot,
  AgentProviderKind,
  AgentProviderStatus,
  AgentSessionSnapshot,
  AgentSessionUpdate,
  AgentSettings,
  AgentTokenUsage,
  DesktopProjectSession,
} from "../../shared/api";
import { formatTimecode } from "../lib/format";
import { useUiStore } from "../store/ui-store";

interface AgentsSidebarProps {
  session: DesktopProjectSession;
  onConfigure: () => void;
}

export function AgentsSidebar({ session, onConfigure }: AgentsSidebarProps) {
  const [snapshot, setSnapshot] = useState<AgentProjectSnapshot | null>(null);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [providers, setProviders] = useState<AgentProviderStatus[]>([]);
  const [composer, setComposer] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadUs = useUiStore((state) => state.playheadUs);
  const selectedClipId = useUiStore((state) => state.selectedClipId);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.cinesim.getAgents(session.directory),
      window.cinesim.getAgentSettings(),
      window.cinesim.refreshAgentProviders(),
    ])
      .then(async ([agentSnapshot, agentSettings, providerStatuses]) => {
        if (!active) return;
        setSettings(agentSettings);
        setProviders(providerStatuses);
        let nextSnapshot = agentSnapshot;
        if (agentSnapshot.sessions.length === 0) {
          const connected = providerStatuses.filter((status) => status.state === "connected");
          const preferred =
            connected.find((status) => status.provider === agentSettings.defaultProvider) ??
            connected[0];
          if (preferred) {
            try {
              nextSnapshot = await window.cinesim.ensureAgent({
                projectDirectory: session.directory,
                provider: preferred.provider,
              });
            } catch (caught) {
              if (active)
                setError(
                  caught instanceof Error ? caught.message : "Could not prepare a project agent",
                );
            }
          }
        }
        if (active) setSnapshot(nextSnapshot);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load agents");
      });
    const unsubscribe = window.cinesim.onAgentsChanged((next) => {
      if (next.projectDirectory === session.directory) setSnapshot(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session.directory]);

  const activeSession = useMemo(
    () => snapshot?.sessions.find((candidate) => candidate.id === snapshot.activeSessionId) ?? null,
    [snapshot],
  );
  const activeEventCount = activeSession?.events.length;
  const activeLastEventText = activeSession?.events.at(-1)?.text;

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeEventCount, activeLastEventText]);

  async function create(provider: AgentProviderKind): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(
        await window.cinesim.createAgent({
          projectDirectory: session.directory,
          provider,
        }),
      );
      setCreating(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create agent");
    }
    setBusy(false);
  }

  async function sendMessage(): Promise<void> {
    if (!activeSession || !composer.trim() || busy) return;
    const message = composer;
    setComposer("");
    setBusy(true);
    setError(null);
    try {
      setSnapshot(
        await window.cinesim.sendAgentMessage(activeSession.id, message, {
          activeSequenceId: session.project.activeSequenceId,
          playheadUs,
          ...(selectedClipId ? { selectedIds: [selectedClipId] } : {}),
        }),
      );
    } catch (caught) {
      setComposer(message);
      setError(caught instanceof Error ? caught.message : "Could not send message");
    }
    setBusy(false);
  }

  async function updateActiveSession(update: AgentSessionUpdate): Promise<void> {
    if (!activeSession || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await window.cinesim.updateAgent(activeSession.id, update));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update agent settings");
    }
    setBusy(false);
  }

  const availableProviders = providers.filter((provider) => provider.state === "connected");
  if (!snapshot || !settings)
    return <div className="grid h-full place-items-center text-ui text-muted">Loading agents…</div>;
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
                    void window.cinesim.selectAgent(session.directory, agent.id).then(setSnapshot);
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
              void window.cinesim
                .deleteAgent(session.directory, activeSession.id)
                .then(setSnapshot);
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
            {(["claude", "codex"] as const).map((provider) => {
              const status = providers.find((candidate) => candidate.provider === provider);
              return (
                <button
                  key={provider}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui hover:bg-surface disabled:opacity-50"
                  disabled={status?.state !== "connected" || busy}
                  onClick={() => void create(provider)}
                >
                  <Bot size={14} className="text-muted" />
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
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {activeSession.events.length > 0 && (
              <div className="space-y-2.5">
                {activeSession.events.map((event) => (
                  <AgentEventView
                    key={event.id}
                    event={event}
                    session={activeSession}
                    onSnapshot={setSnapshot}
                  />
                ))}
              </div>
            )}
          </div>
          {error && (
            <p className="mx-3 mb-2 rounded-md border border-border bg-panel-muted px-2.5 py-2 text-ui-xs text-secondary">
              {error}
            </p>
          )}
          <div className="shrink-0 border-t border-border p-3">
            <div className="rounded-xl border border-border bg-canvas p-2.5 shadow-sm shadow-black/5 transition-colors focus-within:border-border-strong">
              <textarea
                className="block max-h-44 min-h-24 w-full resize-none bg-transparent px-1 py-0.5 text-ui leading-5 text-primary outline-none placeholder:text-disabled"
                value={composer}
                placeholder={
                  agentRunning
                    ? "Agent is working…"
                    : "Ask to make edits, inspect the timeline, or reference clip IDs…"
                }
                disabled={agentRunning}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-0.5">
                  <ModelMenu
                    session={activeSession}
                    defaultModel={settings.providers[activeSession.provider].model}
                    disabled={agentRunning || busy}
                    onSelect={(model) => void updateActiveSession({ model })}
                    onConfigure={onConfigure}
                  />
                  <label className="flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-ui-xs text-muted hover:bg-surface hover:text-secondary">
                    <Gauge size={12} className="shrink-0" />
                    <select
                      className="min-w-0 max-w-16 appearance-none bg-transparent text-ui-xs capitalize text-inherit outline-none"
                      aria-label="Agent reasoning effort"
                      value={activeSession.effort}
                      disabled={agentRunning || busy}
                      onChange={(event) =>
                        void updateActiveSession({
                          effort: event.target.value as AgentEffort,
                        })
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="xhigh">Extra high</option>
                      <option value="max">Maximum</option>
                    </select>
                  </label>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <ContextUsage
                    usage={activeSession.tokenUsage}
                    session={activeSession}
                    playheadLabel={formatTimecode(
                      playheadUs,
                      session.project.sequences.find(
                        (sequence) => sequence.id === session.project.activeSequenceId,
                      )?.frameRate,
                    )}
                  />
                  {agentRunning ? (
                    <button
                      className="grid size-7 place-items-center rounded-md bg-accent text-on-accent hover:bg-accent-hover"
                      aria-label="Stop agent"
                      title="Stop"
                      onClick={() =>
                        void window.cinesim.interruptAgent(activeSession.id).then(setSnapshot)
                      }
                    >
                      <Square size={11} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="grid size-7 place-items-center rounded-md bg-accent text-on-accent hover:bg-accent-hover disabled:bg-surface disabled:text-disabled"
                      aria-label="Send message"
                      disabled={!composer.trim() || busy}
                      onClick={() => void sendMessage()}
                    >
                      <Send size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="mt-1.5 text-center text-[10px] leading-3 text-disabled">
              Agents can make mistakes. Review checkpoint changes before continuing.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

const PROVIDER_MODELS: Record<AgentProviderKind, Array<{ value: string; label: string }>> = {
  claude: [
    { value: "sonnet", label: "Sonnet · latest" },
    { value: "opus", label: "Opus · latest" },
    { value: "fable", label: "Fable · latest" },
    { value: "haiku", label: "Haiku · latest" },
  ],
  codex: [
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.4", label: "GPT-5.4" },
  ],
};

function ModelMenu({
  session,
  defaultModel,
  disabled,
  onSelect,
  onConfigure,
}: {
  session: AgentSessionSnapshot;
  defaultModel: string;
  disabled: boolean;
  onSelect: (model: string) => void;
  onConfigure: () => void;
}) {
  const models = [
    ...PROVIDER_MODELS[session.provider],
    ...[session.model, defaultModel]
      .filter(
        (model, index, values) =>
          model &&
          values.indexOf(model) === index &&
          !PROVIDER_MODELS[session.provider].some((option) => option.value === model),
      )
      .map((model) => ({ value: model, label: model })),
  ];
  const selected = models.find((model) => model.value === session.model)?.label ?? session.model;
  return (
    <details className="group relative">
      <summary
        className={cn(
          "flex h-7 max-w-24 list-none items-center gap-1 rounded-md px-1.5 text-ui-xs text-secondary hover:bg-surface hover:text-primary",
          disabled && "pointer-events-none opacity-50",
        )}
        title={`${providerLabel(session.provider)} model`}
      >
        <Bot size={12} className="shrink-0" />
        <span className="truncate">{selected}</span>
        <ChevronDown size={11} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute bottom-9 left-0 z-50 w-60 overflow-hidden rounded-lg border border-border bg-panel p-1 shadow-xl shadow-black/15">
        <p className="flex items-center gap-2 px-2 py-1.5 text-ui-xs font-medium text-muted">
          <Bot size={12} /> {providerLabel(session.provider)} models
        </p>
        <div className="max-h-64 overflow-y-auto">
          {models.map((model) => (
            <button
              key={model.value}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui hover:bg-surface",
                model.value === session.model && "bg-surface",
              )}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                onSelect(model.value);
              }}
            >
              <span className="grid size-4 place-items-center">
                {model.value === session.model && <Check size={12} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{model.label}</span>
            </button>
          ))}
        </div>
        <button
          className="mt-1 flex w-full items-center gap-2 border-t border-border px-2 py-2 text-left text-ui-xs text-muted hover:text-primary"
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            onConfigure();
          }}
        >
          <Settings size={12} /> Custom model in Settings…
        </button>
      </div>
    </details>
  );
}

function ContextUsage({
  usage,
  session,
  playheadLabel,
}: {
  usage: AgentTokenUsage | undefined;
  session: AgentSessionSnapshot;
  playheadLabel: string;
}) {
  const usedPercent = usage?.maxTokens
    ? Math.min(100, Math.max(0, (usage.usedTokens / usage.maxTokens) * 100))
    : 0;
  const remainingPercent = 100 - usedPercent;
  return (
    <details className="group relative">
      <summary
        className="flex h-7 list-none items-center gap-1 rounded-md px-1.5 text-ui-xs text-muted hover:bg-surface hover:text-primary"
        title="Context window"
      >
        <ContextRing percent={usedPercent} />
        <span>{usage?.maxTokens ? `${Math.round(remainingPercent)}%` : "—"}</span>
      </summary>
      <div className="absolute bottom-9 right-0 z-50 w-72 rounded-lg border border-border bg-panel p-3 shadow-xl shadow-black/15">
        <div className="flex items-center justify-between gap-3">
          <p className="text-ui font-medium text-primary">Context</p>
          <p className="text-ui-xs tabular-nums text-muted">
            {usage
              ? `${formatTokens(usage.usedTokens)}${usage.maxTokens ? ` / ${formatTokens(usage.maxTokens)}` : " used"}`
              : "Waiting for provider"}
          </p>
        </div>
        {usage ? (
          <>
            {usage.maxTokens ? (
              <>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-in-out"
                    style={{ width: `${usedPercent}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-ui-xs text-muted">
                  <span>Window used</span>
                  <span className="tabular-nums">{usedPercent.toFixed(1)}%</span>
                </div>
              </>
            ) : (
              <p className="mt-2 text-ui-xs leading-4 text-muted">
                This provider reported token use without a context-window limit.
              </p>
            )}
            <div className="mt-3 space-y-1.5 border-t border-border pt-3">
              <UsageRow label="Input" value={usage.inputTokens} />
              <UsageRow label="Cached input" value={usage.cachedInputTokens} />
              <UsageRow label="Output" value={usage.outputTokens} />
              <UsageRow label="Reasoning output" value={usage.reasoningOutputTokens} />
              <UsageRow label="Processed this session" value={usage.totalProcessedTokens} />
            </div>
          </>
        ) : (
          <p className="mt-2 text-ui-xs leading-4 text-muted">
            Context usage will appear after {providerLabel(session.provider)} reports the first
            turn.
          </p>
        )}
        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
          <UsageRow label="Provider" text={providerLabel(session.provider)} />
          <UsageRow label="Model" text={session.model} />
          <UsageRow label="Effort" text={effortLabel(session.effort)} />
          <UsageRow label="Next turn playhead" text={playheadLabel} />
          {usage && (
            <UsageRow
              label="Updated"
              text={new Date(usage.updatedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            />
          )}
        </div>
      </div>
    </details>
  );
}

function ContextRing({ percent }: { percent: number }) {
  const circumference = Math.PI * 14;
  return (
    <svg className="size-4 -rotate-90" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeOpacity="0.2" />
      <circle
        cx="9"
        cy="9"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
      />
    </svg>
  );
}

function UsageRow({
  label,
  value,
  text,
}: {
  label: string;
  value?: number | undefined;
  text?: string | undefined;
}) {
  if (value === undefined && text === undefined) return null;
  return (
    <div className="flex items-start justify-between gap-4 text-ui-xs">
      <span className="text-muted">{label}</span>
      <span className="max-w-40 break-words text-right tabular-nums text-secondary">
        {text ?? formatTokens(value!)}
      </span>
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function effortLabel(effort: AgentEffort): string {
  if (effort === "xhigh") return "Extra high";
  if (effort === "max") return "Maximum";
  return effort[0]!.toUpperCase() + effort.slice(1);
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
          <Bot size={18} />
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

function AgentEventView({
  event,
  session,
  onSnapshot,
}: {
  event: AgentEvent;
  session: AgentSessionSnapshot;
  onSnapshot: (snapshot: AgentProjectSnapshot) => void;
}) {
  if (event.kind === "user-message")
    return (
      <div className="ml-7 rounded-xl bg-surface px-3 py-2 text-ui leading-5 text-primary">
        {event.text}
      </div>
    );
  if (event.kind === "assistant-message")
    return (
      <div className="whitespace-pre-wrap px-1 text-ui leading-5 text-primary">{event.text}</div>
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
            onClick={() =>
              void window.cinesim
                .respondAgentApproval(session.id, event.requestId!, "decline")
                .then(onSnapshot)
            }
          >
            Decline
          </button>
          <button
            className="h-7 rounded-md bg-accent px-2.5 text-ui-xs text-on-accent hover:bg-accent-hover"
            onClick={() =>
              void window.cinesim
                .respondAgentApproval(session.id, event.requestId!, "accept")
                .then(onSnapshot)
            }
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
      <div className="rounded-lg border border-border bg-panel-muted p-2.5">
        <div className="flex items-start gap-2">
          <Clock3 size={13} className="mt-0.5 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-ui-xs font-medium text-secondary">{event.title}</p>
            <p className="mt-1 whitespace-pre-wrap text-ui-xs leading-4 text-muted">
              {event.detail}
            </p>
          </div>
          {checkpoint && (
            <button
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary"
              aria-label="Revert turn"
              title="Revert this turn"
              onClick={() =>
                void window.cinesim.revertAgentTurn(session.id, checkpoint.turnId).then(onSnapshot)
              }
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      </div>
    );
  }
  if (event.kind === "tool-started" || event.kind === "tool-completed")
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-panel-muted px-2.5 py-2">
        <Wrench size={13} className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-xs font-medium capitalize text-secondary">{event.title}</p>
          {event.detail && (
            <p className="mt-0.5 break-words text-ui-xs leading-4 text-muted">{event.detail}</p>
          )}
        </div>
        {event.status === "running" ? (
          <span className="mt-1 size-1.5 animate-pulse rounded-full bg-muted" />
        ) : event.status === "failed" ? (
          <CircleAlert size={12} className="text-muted" />
        ) : (
          <Check size={12} className="text-muted" />
        )}
      </div>
    );
  return (
    <div
      className={cn(
        "rounded-md px-2.5 py-2 text-ui-xs leading-4",
        event.kind === "error"
          ? "border border-border bg-panel-muted text-secondary"
          : "text-muted",
      )}
    >
      {event.title && <p className="font-medium text-secondary">{event.title}</p>}
      {event.detail && <p className="break-words">{event.detail}</p>}
    </div>
  );
}

function providerLabel(provider: AgentProviderKind): string {
  return provider === "claude" ? "Claude Code" : "Codex";
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

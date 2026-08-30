import {
  ArrowUp,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronDown,
  Settings,
  Square,
} from "@cinesim/ui";
import { cn, Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuTrigger } from "@cinesim/ui";
import type {
  AgentEffort,
  AgentSessionSnapshot,
  AgentSessionUpdate,
  AgentTokenUsage,
} from "../../../shared/contracts";
import {
  AGENT_EFFORTS,
  AGENT_PROVIDER_CATALOG,
  effortLabel,
  providerLabel,
} from "../../lib/agent-provider-catalog";
import { ProviderIcon } from "./provider-icon";

interface AgentComposerProps {
  session: AgentSessionSnapshot;
  value: string;
  busy: boolean;
  running: boolean;
  defaultModel: string;
  playheadLabel: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onUpdate: (update: AgentSessionUpdate) => void;
  onConfigure: () => void;
}

export function AgentComposer({
  session,
  value,
  busy,
  running,
  defaultModel,
  playheadLabel,
  onValueChange,
  onSend,
  onStop,
  onUpdate,
  onConfigure,
}: AgentComposerProps) {
  return (
    <div className="relative z-10 shrink-0 bg-canvas p-3">
      <div
        className="pointer-events-none absolute inset-x-0 -top-14 h-14 bg-linear-to-b from-transparent via-canvas/80 to-canvas"
        aria-hidden="true"
      />
      <div className="rounded-xl border border-border bg-canvas p-2.5 shadow-sm shadow-black/5 transition-colors focus-within:border-border-strong">
        <textarea
          className="block max-h-44 min-h-24 w-full resize-none bg-transparent px-1 py-0.5 text-ui leading-5 text-primary outline-none placeholder:text-disabled"
          value={value}
          placeholder={
            running
              ? "Agent is working…"
              : "Ask to make edits, inspect the timeline, or reference clip IDs…"
          }
          disabled={running}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <ModelMenu
              session={session}
              defaultModel={defaultModel}
              disabled={running || busy}
              onSelect={(model) => onUpdate({ model })}
              onConfigure={onConfigure}
            />
            <EffortMenu
              effort={session.effort}
              disabled={running || busy}
              onSelect={(effort) => onUpdate({ effort })}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <ContextUsage
              usage={session.tokenUsage}
              session={session}
              playheadLabel={playheadLabel}
            />
            {running ? (
              <button
                className="grid size-7 place-items-center rounded-md bg-accent text-on-accent hover:bg-accent-hover"
                aria-label="Stop agent"
                title="Stop"
                onClick={onStop}
              >
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                className="grid size-7 place-items-center rounded-md bg-accent text-on-accent hover:bg-accent-hover disabled:bg-surface disabled:text-disabled"
                aria-label="Send message"
                disabled={!value.trim() || busy}
                onClick={onSend}
              >
                <ArrowUp size={15} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EffortMenu({
  effort,
  disabled,
  onSelect,
}: {
  effort: AgentEffort;
  disabled: boolean;
  onSelect: (effort: AgentEffort) => void;
}) {
  return (
    <Menu disabled={disabled}>
      <MenuTrigger
        className={cn(
          "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-ui-xs text-muted hover:bg-surface hover:text-primary data-[disabled]:opacity-50",
        )}
        aria-label="Change agent reasoning effort"
        title="Reasoning effort"
      >
        <ChartNoAxesColumnIncreasing size={13} className="shrink-0" />
        <span>{effortLabel(effort)}</span>
      </MenuTrigger>
      <MenuContent side="top" className="w-40 border-border p-1 shadow-xl shadow-black/15">
        <MenuGroup>
          <MenuLabel>Reasoning effort</MenuLabel>
          {AGENT_EFFORTS.map((option) => (
            <MenuItem
              key={option}
              className={cn(
                "min-h-0 w-full rounded-md px-2 py-2 text-ui text-secondary hover:text-primary",
                option === effort && "bg-surface text-primary",
              )}
              onClick={() => option !== effort && onSelect(option)}
            >
              <span className="grid size-4 place-items-center">
                {option === effort && <Check size={12} />}
              </span>
              <span>{effortLabel(option)}</span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

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
    ...AGENT_PROVIDER_CATALOG[session.provider].models,
    ...[session.model, defaultModel]
      .filter(
        (model, index, values) =>
          model &&
          values.indexOf(model) === index &&
          !AGENT_PROVIDER_CATALOG[session.provider].models.some((option) => option.value === model),
      )
      .map((model) => ({ value: model, label: model })),
  ];
  const selected = models.find((model) => model.value === session.model)?.label ?? session.model;
  return (
    <Menu disabled={disabled}>
      <MenuTrigger
        className={cn(
          "group flex h-7 min-w-0 max-w-44 flex-1 items-center gap-1 rounded-md px-1.5 text-ui-xs text-secondary hover:bg-surface hover:text-primary data-[disabled]:opacity-50",
        )}
        title={`${providerLabel(session.provider)} model`}
      >
        <ProviderIcon provider={session.provider} size={12} className="shrink-0" />
        <span className="truncate">{selected}</span>
        <ChevronDown
          size={11}
          className="shrink-0 transition-transform group-data-[popup-open]:rotate-180"
        />
      </MenuTrigger>
      <MenuContent
        side="top"
        className="w-60 overflow-hidden border-border p-1 shadow-xl shadow-black/15"
      >
        <MenuGroup>
          <MenuLabel className="flex items-center gap-2">
            <ProviderIcon provider={session.provider} size={12} />
            {providerLabel(session.provider)} models
          </MenuLabel>
          <div className="max-h-64 overflow-y-auto">
            {models.map((model) => (
              <MenuItem
                key={model.value}
                className={cn(
                  "min-h-0 w-full rounded-md px-2 py-2 text-ui",
                  model.value === session.model && "bg-surface",
                )}
                onClick={() => onSelect(model.value)}
              >
                <span className="grid size-4 place-items-center">
                  {model.value === session.model && <Check size={12} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{model.label}</span>
              </MenuItem>
            ))}
          </div>
        </MenuGroup>
        <MenuItem
          className="mt-1 flex w-full items-center gap-2 border-t border-border px-2 py-2 text-left text-ui text-muted hover:text-primary"
          onClick={onConfigure}
        >
          <Settings size={12} className="shrink-0" />
          <span className="whitespace-nowrap">Agent settings</span>
        </MenuItem>
      </MenuContent>
    </Menu>
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
        className="grid size-7 list-none place-items-center rounded-md text-muted hover:bg-surface hover:text-primary"
        aria-label={
          usage?.maxTokens
            ? `Context window, ${Math.round(remainingPercent)}% remaining`
            : "Context window"
        }
        title={
          usage?.maxTokens ? `${Math.round(remainingPercent)}% context remaining` : "Context window"
        }
      >
        <ContextRing percent={usedPercent} />
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
  return (
    <svg className="size-4 -rotate-90" viewBox="0 0 18 18" aria-hidden="true">
      <circle
        cx="9"
        cy="9"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeOpacity="0.25"
      />
      <circle
        className="transition-[stroke-dasharray] duration-300 ease-in-out"
        cx="9"
        cy="9"
        r="6.5"
        fill="none"
        pathLength="100"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${percent} 100`}
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

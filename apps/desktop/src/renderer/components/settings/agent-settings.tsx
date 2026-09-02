import { useEffect, useState } from "react";
import { Bot, Check, CircleAlert, FolderOpen, RefreshCw, Terminal } from "@cinesim/ui";
import {
  cn,
  Input,
  Notice,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@cinesim/ui";
import type {
  AgentEffort,
  AgentProviderKind,
  AgentProviderStatus,
  AgentSettings as AgentSettingsState,
  DesktopProjectGuidance,
} from "../../../shared/contracts";
import { useDelayedBusy } from "../../hooks/use-delayed-busy";
import {
  cacheAgentProviders,
  cacheAgentSettings,
  cachedAgentProviders,
  cachedAgentSettings,
} from "../../lib/agent-presentation-cache";
import {
  AGENT_EFFORTS,
  AGENT_PROVIDER_KINDS,
  effortLabel,
  providerLabel,
} from "../../lib/agent-provider-catalog";
import { SettingRow, SettingsHeading } from "./settings-layout";

export function AgentSettings() {
  const cachedSettings = cachedAgentSettings();
  const [settings, setSettings] = useState<AgentSettingsState | null>(cachedSettings);
  const [statuses, setStatuses] = useState<AgentProviderStatus[]>(() => cachedAgentProviders());
  const [provider, setProvider] = useState<AgentProviderKind>(
    cachedSettings?.defaultProvider ?? "claude",
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const showLoading = useDelayedBusy(!settings);

  async function refresh(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const nextStatuses = await window.cinesim.agents.refreshProviders();
      cacheAgentProviders(nextStatuses);
      setStatuses(nextStatuses);
      const nextSettings = await window.cinesim.agents.getSettings();
      cacheAgentSettings(nextSettings);
      setSettings(nextSettings);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not inspect local agents");
    }
    setBusy(false);
  }

  useEffect(() => {
    void (async () => {
      const value = await window.cinesim.agents.getSettings();
      cacheAgentSettings(value);
      setSettings(value);
      setProvider(value.defaultProvider);
      await refresh();
    })();
  }, []);

  async function updateProvider(input: { model?: string; effort?: AgentEffort }): Promise<void> {
    const next = await window.cinesim.agents.updateSettings({ provider, ...input });
    cacheAgentSettings(next);
    setSettings(next);
  }

  async function chooseExecutable(): Promise<void> {
    const next = await window.cinesim.agents.chooseExecutable(provider);
    if (next) {
      cacheAgentSettings(next);
      setSettings(next);
      await refresh();
    }
  }

  async function makeDefaultProvider(): Promise<void> {
    const next = await window.cinesim.agents.updateSettings({ defaultProvider: provider });
    cacheAgentSettings(next);
    setSettings(next);
  }

  async function updateProjectInstructions(value: string): Promise<void> {
    const next = await window.cinesim.agents.updateSettings({ projectInstructions: value });
    cacheAgentSettings(next);
    setSettings(next);
  }

  if (!settings)
    return (
      <div className="min-h-40" aria-busy="true">
        {showLoading && (
          <p className="py-20 text-center text-ui text-muted">Inspecting local agents…</p>
        )}
      </div>
    );

  const configured = settings.providers[provider];
  const status = statuses.find((candidate) => candidate.provider === provider);

  return (
    <>
      <div className="mb-7 flex items-start justify-between gap-4">
        <SettingsHeading
          icon={<Bot size={18} />}
          title="Agents"
          detail="Use your local Claude Code or Codex installation"
        />
        <button
          className="mt-1 flex h-8 items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-ui-xs text-secondary hover:bg-surface hover:text-primary disabled:opacity-50"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} className={cn(busy && "animate-spin")} /> Refresh
        </button>
      </div>

      <Tabs value={provider} onValueChange={(value) => setProvider(value as AgentProviderKind)}>
        <TabsList className="mb-6" aria-label="Agent provider">
          {AGENT_PROVIDER_KINDS.map((candidate) => {
            const candidateStatus = statuses.find((entry) => entry.provider === candidate);
            return (
              <TabsTrigger key={candidate} value={candidate}>
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    candidateStatus?.state === "connected" ? "bg-emerald-500" : "bg-disabled",
                  )}
                />
                {providerLabel(candidate)}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value={provider}>
          <ProviderStatus status={status} />

          {(status?.state === "login-required" || status?.state === "error") && (
            <button
              className="mt-3 flex h-8 items-center gap-2 rounded-md border border-border bg-panel px-3 text-ui text-primary hover:bg-surface"
              onClick={() =>
                void window.cinesim.agents.openLogin(provider).then((message) => setNotice(message))
              }
            >
              <Terminal size={14} /> Configure login in Terminal
            </button>
          )}

          <div className="mt-7 divide-y divide-border rounded-xl border border-border bg-panel">
            <SettingRow
              title="Executable path"
              detail={`Leave empty to detect the system ${providerLabel(provider)} executable.`}
            >
              <div className="flex min-w-0 gap-2">
                <Input
                  className="flex-1"
                  value={configured.executablePath}
                  placeholder={status?.executablePath ?? "Not detected"}
                  readOnly
                />
                <button
                  className="grid size-9 place-items-center rounded-md border border-border text-muted hover:bg-surface hover:text-primary"
                  aria-label="Choose executable"
                  onClick={() => void chooseExecutable()}
                >
                  <FolderOpen size={14} />
                </button>
              </div>
            </SettingRow>
            <SettingRow title="Default model" detail="Used when a new project agent is created.">
              <Input
                className="w-full"
                value={configured.model}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    providers: {
                      ...settings.providers,
                      [provider]: { ...configured, model: event.target.value },
                    },
                  })
                }
                onBlur={(event) => void updateProvider({ model: event.target.value })}
              />
            </SettingRow>
            <SettingRow
              title="Reasoning effort"
              detail="Default thinking depth for new sessions with this provider."
            >
              <Select
                className="w-full"
                value={configured.effort}
                onChange={(event) =>
                  void updateProvider({ effort: event.target.value as AgentEffort })
                }
              >
                {AGENT_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effortLabel(effort)}
                  </option>
                ))}
              </Select>
            </SettingRow>
            <SettingRow
              title="New agent default"
              detail="Provider selected when starting a new chat."
            >
              <button
                className={cn(
                  "flex h-9 w-full items-center justify-between rounded-md border px-3 text-ui",
                  settings.defaultProvider === provider
                    ? "border-border-strong bg-surface text-primary"
                    : "border-border bg-canvas text-secondary hover:bg-surface",
                )}
                onClick={() => void makeDefaultProvider()}
              >
                {settings.defaultProvider === provider ? "Current default" : "Make default"}
                {settings.defaultProvider === provider && <Check size={14} />}
              </button>
            </SettingRow>
          </div>

          {notice && (
            <Notice className="mt-4 rounded-lg bg-panel" size="default">
              {notice}
            </Notice>
          )}
        </TabsContent>
      </Tabs>

      <ProjectGuidanceSettings defaultInstructions={settings.projectInstructions} />

      <div className="mt-7 divide-y divide-border rounded-xl border border-border bg-panel">
        <SettingRow
          title="New-project instruction default"
          detail="Default custom suffix added after Cinesim's managed AGENTS.md guidance for new projects."
        >
          <textarea
            className="min-h-28 w-full resize-y rounded-md border border-border bg-canvas px-3 py-2 text-ui text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus"
            value={settings.projectInstructions}
            placeholder="Creative standards, naming rules, or team-specific guidance"
            maxLength={20_000}
            onChange={(event) =>
              setSettings({ ...settings, projectInstructions: event.target.value })
            }
            onBlur={(event) => void updateProjectInstructions(event.target.value)}
          />
        </SettingRow>
      </div>
    </>
  );
}

function ProjectGuidanceSettings({ defaultInstructions }: { defaultInstructions: string }) {
  const [guidance, setGuidance] = useState<DesktopProjectGuidance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.cinesim.project
      .getAgentGuidance()
      .then(setGuidance)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Could not load project guidance"),
      );
  }, []);

  async function updateProjectInstructions(customInstructions: string) {
    try {
      setGuidance(await window.cinesim.project.updateAgentGuidance(customInstructions));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update project guidance");
    }
  }

  if (!guidance) return null;
  return (
    <div className="mt-7 divide-y divide-border rounded-xl border border-border bg-panel">
      <SettingRow
        title="Managed project guidance"
        detail="Versioned Cinesim instructions regenerated on project creation and open."
      >
        <textarea
          className="min-h-56 w-full resize-y rounded-md border border-border bg-canvas px-3 py-2 font-mono text-ui-xs leading-5 text-secondary outline-none"
          value={guidance.managedBlock}
          readOnly
          aria-label="Managed Cinesim project guidance"
        />
      </SettingRow>
      {guidance.projectCustomInstructions !== null && (
        <SettingRow
          title="Open-project custom instructions"
          detail="This suffix follows the managed block in AGENTS.md and is shared by internal and external agents."
        >
          <div className="space-y-2">
            <textarea
              className="min-h-28 w-full resize-y rounded-md border border-border bg-canvas px-3 py-2 text-ui text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus"
              value={guidance.projectCustomInstructions}
              maxLength={20_000}
              onChange={(event) =>
                setGuidance({ ...guidance, projectCustomInstructions: event.target.value })
              }
              onBlur={(event) => void updateProjectInstructions(event.target.value)}
            />
            <button
              className="h-8 rounded-md border border-border bg-canvas px-3 text-ui-xs text-secondary hover:bg-surface hover:text-primary"
              onClick={() => void updateProjectInstructions(defaultInstructions)}
            >
              Revert to default and regenerate
            </button>
          </div>
        </SettingRow>
      )}
      {error && (
        <Notice className="m-3 rounded-lg bg-canvas" size="default">
          {error}
        </Notice>
      )}
    </div>
  );
}

function ProviderStatus({ status }: { status: AgentProviderStatus | undefined }) {
  if (!status) return <Skeleton className="h-20 rounded-xl border border-border bg-panel" />;
  const connected = status.state === "connected";
  return (
    <div className="rounded-xl border border-border bg-panel px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full",
            connected ? "bg-emerald-500/12 text-emerald-500" : "bg-surface text-muted",
          )}
        >
          {connected ? <Check size={14} /> : <CircleAlert size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium text-primary">
            {connected
              ? "Connected"
              : status.state === "not-found"
                ? "Not installed"
                : status.state === "login-required"
                  ? "Login required"
                  : "Installation needs attention"}
          </p>
          <p className="mt-0.5 break-words text-ui-xs leading-4 text-muted">
            {status.detail ?? status.accountLabel ?? status.executablePath}
          </p>
          {(status.version || status.accountLabel) && (
            <p className="mt-2 text-ui-xs text-secondary">
              {[status.version, status.accountLabel].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

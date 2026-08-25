import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  FolderOpen,
  RefreshCw,
  Settings as SettingsIcon,
  Terminal,
} from "lucide-react";
import {
  cn,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
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
  AgentPermissionMode,
  AgentProviderKind,
  AgentProviderStatus,
  AgentSettings,
} from "../../../shared/api";
import {
  AGENT_EFFORTS,
  AGENT_PROVIDER_KINDS,
  effortLabel,
  providerLabel,
} from "../../lib/agent-provider-catalog";

interface SettingsProps {
  section: "general" | "agents";
}

export function Settings({ section }: SettingsProps) {
  return (
    <section className="h-full overflow-y-auto bg-canvas px-8 py-9">
      <div className="mx-auto max-w-3xl">
        {section === "agents" ? <AgentSettings /> : <GeneralSettings />}
      </div>
    </section>
  );
}

function GeneralSettings() {
  return (
    <>
      <SettingsHeading
        icon={<SettingsIcon size={18} />}
        title="General"
        detail="Global Cinesim preferences"
      />
      <div className="rounded-xl border border-border bg-panel p-6">
        <p className="text-ui font-medium">Project preferences stay with each project</p>
        <p className="mt-1 max-w-lg text-ui text-muted">
          Preview quality, autosave, and creative settings are stored in the open Cinesim project.
          Agent providers are configured separately in the Agents section.
        </p>
      </div>
    </>
  );
}

function AgentSettings() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [statuses, setStatuses] = useState<AgentProviderStatus[]>([]);
  const [provider, setProvider] = useState<AgentProviderKind>("claude");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const nextStatuses = await window.cinesim.refreshAgentProviders();
      setStatuses(nextStatuses);
      setSettings(await window.cinesim.getAgentSettings());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not inspect local agents");
    }
    setBusy(false);
  }

  useEffect(() => {
    void window.cinesim.getAgentSettings().then((value) => {
      setSettings(value);
      setProvider(value.defaultProvider);
      void refresh();
    });
  }, []);

  async function updateProvider(input: {
    executablePath?: string;
    model?: string;
    effort?: AgentEffort;
    permissionMode?: AgentPermissionMode;
  }): Promise<void> {
    const next = await window.cinesim.updateAgentSettings({ provider, ...input });
    setSettings(next);
  }

  async function chooseExecutable(): Promise<void> {
    const next = await window.cinesim.chooseAgentExecutable(provider);
    if (next) {
      setSettings(next);
      await refresh();
    }
  }

  if (!settings)
    return <p className="py-20 text-center text-ui text-muted">Inspecting local agents…</p>;

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
                void window.cinesim.openAgentLogin(provider).then((message) => setNotice(message))
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
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      providers: {
                        ...settings.providers,
                        [provider]: { ...configured, executablePath: event.target.value },
                      },
                    })
                  }
                  onBlur={(event) => void updateProvider({ executablePath: event.target.value })}
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
              title="Editing approvals"
              detail="Supervised mode asks before every canonical timeline change."
            >
              <Select
                className="w-full"
                value={configured.permissionMode}
                onChange={(event) =>
                  void updateProvider({ permissionMode: event.target.value as AgentPermissionMode })
                }
              >
                <option value="supervised">Supervised</option>
                <option value="auto-edit">Auto-accept Cinesim edits</option>
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
                onClick={() =>
                  void window.cinesim
                    .updateAgentSettings({ defaultProvider: provider })
                    .then(setSettings)
                }
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
    </>
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

function SettingsHeading({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="mb-7 flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl border border-border bg-panel text-secondary">
        {icon}
      </span>
      <div>
        <h1 className="text-ui-lg font-semibold tracking-tight">{title}</h1>
        <p className="text-ui text-muted">{detail}</p>
      </div>
    </div>
  );
}

function SettingRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <Field className="p-4 sm:grid-cols-[minmax(0,1fr)_minmax(230px,0.9fr)] sm:items-center">
      <FieldContent>
        <FieldLabel>{title}</FieldLabel>
        <FieldDescription>{detail}</FieldDescription>
      </FieldContent>
      <div className="min-w-0">{children}</div>
    </Field>
  );
}

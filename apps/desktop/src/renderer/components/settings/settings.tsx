import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  AudioLines,
  Check,
  CircleAlert,
  Cloud,
  Database,
  Film,
  FolderOpen,
  RefreshCw,
  Settings as SettingsIcon,
  Terminal,
  User,
} from "@cinesim/ui";
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
  CloudStorageUsage,
  TranscriptionSettings as TranscriptionSettingsState,
} from "../../../shared/api";
import { sessionFromLifecycle, type SettingsSection } from "../../store/renderer-store";
import {
  AGENT_EFFORTS,
  AGENT_PROVIDER_KINDS,
  effortLabel,
  providerLabel,
} from "../../lib/agent-provider-catalog";
import { useRendererStore } from "../../store/renderer-store-context";
import { useDelayedBusy } from "../../hooks/use-delayed-busy";
import {
  cacheAgentProviders,
  cacheAgentSettings,
  cachedAgentProviders,
  cachedAgentSettings,
} from "../../lib/agent-presentation-cache";
import { AccountAvatar, GoogleMark } from "../account/account-ui";
import { grantTranscriptionConsent } from "../transcript/transcription-consent";

interface SettingsProps {
  section: SettingsSection;
}

type CloudUsageState =
  | { status: "idle" }
  | { status: "loading"; previous: CloudStorageUsage | null }
  | { status: "ready"; usage: CloudStorageUsage }
  | { status: "failed"; previous: CloudStorageUsage | null; error: string };

function cloudUsage(state: CloudUsageState): CloudStorageUsage | null {
  if (state.status === "ready") return state.usage;
  if (state.status === "loading" || state.status === "failed") return state.previous;
  return null;
}

export function Settings({ section }: SettingsProps) {
  return (
    <section className="h-full overflow-y-auto bg-canvas px-8 py-9">
      <div className="mx-auto max-w-3xl">
        {section === "agents" ? (
          <AgentSettings />
        ) : section === "storage" ? (
          <CloudStorageSettings />
        ) : section === "media" ? (
          <MediaSettings />
        ) : section === "transcription" ? (
          <TranscriptionSettings />
        ) : section === "account" ? (
          <AccountSettings />
        ) : (
          <GeneralSettings />
        )}
      </div>
    </section>
  );
}

function TranscriptionSettings() {
  const account = useRendererStore((state) => state.account);
  const settings = useRendererStore((state) => state.appState.transcriptionSettings);
  const save = useRendererStore((state) => state.saveTranscriptionSettings);
  const [saving, setSaving] = useState(false);

  async function update(next: TranscriptionSettingsState): Promise<void> {
    if (account.status !== "signed-in" || !account.user) return;
    if (next.generation === "automatic") grantTranscriptionConsent(account.user.id);
    setSaving(true);
    await save(next);
    setSaving(false);
  }

  return (
    <>
      <SettingsHeading
        icon={<AudioLines size={18} />}
        title="Transcription"
        detail="Choose how speech transcripts are generated for your account"
      />
      {account.status !== "signed-in" ? (
        <Notice size="default">Sign in to configure remote transcription.</Notice>
      ) : account.transcription !== true ? (
        <Notice size="default">
          Transcription is not configured for this Cinesim service. Your preference will remain
          available when the service enables it.
        </Notice>
      ) : (
        <>
          <Notice className="mb-5 rounded-lg bg-panel" size="default">
            Transcription sends bounded audio chunks directly to Deepgram. Audio leaves this Mac;
            the generated transcript remains disposable data under
            <code className="mx-1 rounded bg-panel-muted px-1 py-0.5 text-primary">.video</code>.
            Choosing automatic generation authorizes this remote processing for newly encountered
            speech media while you are signed in.
          </Notice>
          <div className="divide-y divide-border rounded-xl border border-border bg-panel">
            <SettingRow
              title="Transcription generation"
              detail="Choose whether audio-bearing media is queued when an open project is inspected."
            >
              <Select
                className="w-full"
                value={settings.generation}
                disabled={saving}
                onChange={(event) =>
                  void update({
                    ...settings,
                    generation: event.target.value as TranscriptionSettingsState["generation"],
                  })
                }
              >
                <option value="manual">Manual</option>
                <option value="automatic">Automatic</option>
              </Select>
            </SettingRow>
            <SettingRow
              title="Speech model"
              detail="The timing, diarization, and formatting model used for generated transcripts."
            >
              <Select
                className="w-full"
                value={settings.model}
                disabled={saving}
                onChange={(event) =>
                  void update({
                    ...settings,
                    model: event.target.value as TranscriptionSettingsState["model"],
                  })
                }
              >
                <option value="deepgram/nova-3">Deepgram Nova-3 · Direct</option>
              </Select>
            </SettingRow>
          </div>
          <div className="mt-5 rounded-xl border border-border bg-panel p-5">
            <p className="text-ui font-medium text-primary">Document-editing features</p>
            <p className="mt-1 text-ui leading-5 text-muted">
              Nova-3 runs with word timings, confidence, speaker diarization, utterances,
              paragraphs, punctuation, smart formatting, language detection, keyterms, and filler
              words. Profanity filtering and automatic redaction remain off so the transcript does
              not silently change the source record.
            </p>
          </div>
        </>
      )}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function CloudStorageSettings() {
  const account = useRendererStore((state) => state.account);
  const transfers = useRendererStore((state) => state.cloudTransfers);
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const [usageState, setUsageState] = useState<CloudUsageState>({ status: "idle" });
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const usage = cloudUsage(usageState);
  const loading = usageState.status === "loading";
  const error = usageState.status === "failed" ? usageState.error : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (account.status !== "signed-in") return;
    setUsageState({ status: "loading", previous: usage });
    try {
      setUsageState({ status: "ready", usage: await window.cinesim.getCloudStorageUsage() });
    } catch (caught) {
      setUsageState({
        status: "failed",
        previous: usage,
        error: caught instanceof Error ? caught.message : "Cloud storage usage is unavailable",
      });
    }
  }, [account.status, usage]);

  useEffect(() => {
    if (account.status !== "signed-in") return;

    let active = true;
    void window.cinesim
      .getCloudStorageUsage()
      .then((nextUsage) => {
        if (!active) return;
        setUsageState({ status: "ready", usage: nextUsage });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setUsageState((current) => ({
          status: "failed",
          previous: cloudUsage(current),
          error: caught instanceof Error ? caught.message : "Cloud storage usage is unavailable",
        }));
      });

    return () => {
      active = false;
    };
  }, [account.status, transfers]);

  if (account.status !== "signed-in")
    return <Notice size="default">Sign in to configure and inspect Cinesim Cloud storage.</Notice>;
  if (account.cloudStorage !== true)
    return (
      <Notice size="default">Cloud storage is not configured for this Cinesim service.</Notice>
    );

  const allowance = (usage?.includedBytes ?? 0) + (usage?.addonBytes ?? 0);
  const occupied = (usage?.usedBytes ?? 0) + (usage?.reservedBytes ?? 0);
  const ratio = allowance > 0 ? Math.min(1, occupied / allowance) : 0;
  const activeCloudAssets = new Set<string>(
    session?.project.assets.flatMap((asset) =>
      asset.source.kind === "cloud" ? [asset.source.cloudAssetId] : [],
    ) ?? [],
  );

  async function mutateAsset(id: string, operation: "trash" | "restore" | "delete") {
    setBusyAssetId(id);
    try {
      if (operation === "trash") await window.cinesim.trashCloudAssets([id]);
      else if (operation === "restore") await window.cinesim.restoreCloudAsset(id);
      else await window.cinesim.deleteCloudAsset(id);
      setConfirmDelete(null);
      await refresh();
    } catch (caught) {
      setUsageState({
        status: "failed",
        previous: usage,
        error: caught instanceof Error ? caught.message : "The cloud asset could not be updated",
      });
    }
    setBusyAssetId(null);
  }

  async function configureAddon(addonBytes: number): Promise<void> {
    setUsageState({ status: "loading", previous: usage });
    try {
      setUsageState({
        status: "ready",
        usage: await window.cinesim.configureCloudStorageAddon(addonBytes),
      });
    } catch (caught) {
      setUsageState({
        status: "failed",
        previous: usage,
        error: caught instanceof Error ? caught.message : "The storage allowance could not change",
      });
    }
  }

  return (
    <>
      <SettingsHeading
        icon={<Cloud size={18} />}
        title="Cloud storage"
        detail="Original media stored privately with your Cinesim account"
      />
      <div className="rounded-xl border border-border bg-panel p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-ui font-semibold text-primary">Account storage</p>
            <p className="mt-1 text-ui text-muted">
              {usage
                ? `${formatBytes(usage.usedBytes)} used · ${formatBytes(usage.reservedBytes)} uploading · ${formatBytes(allowance)} available`
                : "Loading storage usage…"}
            </p>
          </div>
          <button
            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-ui text-secondary hover:bg-surface disabled:opacity-50"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={cn(loading && "animate-spin")} /> Refresh
          </button>
        </div>
        <div className="mt-5 h-2 overflow-hidden rounded-full bg-surface" aria-hidden="true">
          <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
        </div>
        {usage && (
          <div className="mt-3 flex justify-between text-ui-xs text-muted">
            <span>{Math.round(ratio * 100)}% occupied</span>
            <span>
              {formatBytes(usage.includedBytes)} included
              {usage.addonBytes > 0 ? ` + ${formatBytes(usage.addonBytes)} added` : ""}
            </span>
          </div>
        )}
      </div>

      {error && (
        <Notice className="mt-4 rounded-lg bg-panel" size="default">
          {error}
        </Notice>
      )}

      <div className="mt-5 rounded-xl border border-border bg-panel">
        <div className="border-b border-border px-5 py-4">
          <p className="flex items-center gap-2 text-ui font-semibold text-primary">
            <Database size={14} /> Storage by project
          </p>
          <p className="mt-1 text-ui-xs text-muted">
            Trashed originals continue to use storage until permanently deleted.
          </p>
        </div>
        {usage?.projects.length ? (
          <div className="divide-y divide-border">
            {usage.projects.map((project) => (
              <div key={project.id} className="px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <p className="truncate text-ui font-medium text-primary">{project.name}</p>
                  <p className="shrink-0 text-ui-xs tabular-nums text-muted">
                    {formatBytes(project.usedBytes)}
                  </p>
                </div>
                <div className="mt-3 space-y-2">
                  {project.assets.map((asset) => (
                    <div key={asset.id} className="flex items-center gap-3 text-ui-xs">
                      <span className="min-w-0 flex-1 truncate text-secondary">{asset.name}</span>
                      <span className="rounded bg-surface px-1.5 py-0.5 capitalize text-muted">
                        {asset.state}
                      </span>
                      <span className="w-16 text-right tabular-nums text-muted">
                        {formatBytes(asset.bytes)}
                      </span>
                      {asset.state === "ready" && (
                        <button
                          className="rounded border border-border px-2 py-1 text-muted hover:bg-surface hover:text-primary disabled:opacity-50"
                          disabled={busyAssetId !== null || activeCloudAssets.has(asset.id)}
                          title={
                            activeCloudAssets.has(asset.id)
                              ? "Remove this asset from its project before moving the original to Trash"
                              : "Move original to Trash"
                          }
                          onClick={() => void mutateAsset(asset.id, "trash")}
                        >
                          Trash
                        </button>
                      )}
                      {asset.state === "trashed" && (
                        <>
                          <button
                            className="rounded border border-border px-2 py-1 text-muted hover:bg-surface hover:text-primary disabled:opacity-50"
                            disabled={busyAssetId !== null}
                            onClick={() => void mutateAsset(asset.id, "restore")}
                          >
                            Restore
                          </button>
                          <button
                            className="rounded border border-border px-2 py-1 text-muted hover:bg-surface hover:text-primary disabled:opacity-50"
                            disabled={busyAssetId !== null}
                            onClick={() =>
                              confirmDelete === asset.id
                                ? void mutateAsset(asset.id, "delete")
                                : setConfirmDelete(asset.id)
                            }
                          >
                            {confirmDelete === asset.id ? "Confirm delete" : "Delete"}
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-5 py-8 text-center text-ui text-muted">
            {usage ? "No cloud originals yet." : "Loading project usage…"}
          </p>
        )}
      </div>

      <div className="mt-5 rounded-xl border border-border bg-panel p-5">
        <p className="text-ui font-medium text-primary">Additional storage</p>
        <p className="mt-1 text-ui text-muted">
          Choose an account allowance made available by this Cinesim service. You cannot reduce it
          below storage already in use.
        </p>
        {usage && (
          <Select
            className="mt-4 max-w-xs"
            aria-label="Additional cloud storage"
            value={usage.addonBytes}
            disabled={loading || usage.addonOptionsBytes.length <= 1}
            onChange={(event) => void configureAddon(Number(event.target.value))}
          >
            {usage.addonOptionsBytes.map((bytes) => (
              <option key={bytes} value={bytes}>
                {bytes === 0 ? "Included storage only" : `Add ${formatBytes(bytes)}`}
              </option>
            ))}
          </Select>
        )}
        {usage?.addonOptionsBytes.length === 1 && (
          <p className="mt-3 text-ui-xs text-muted">
            No additional allowances are configured for this service.
          </p>
        )}
      </div>
    </>
  );
}

const PROXY_PRESETS = {
  "space-saver": { proxyMaxLongEdge: 960, proxyFrameRateCap: 30, proxyQuality: "low" },
  balanced: { proxyMaxLongEdge: 1280, proxyFrameRateCap: 60, proxyQuality: "medium" },
  "high-quality": { proxyMaxLongEdge: 1920, proxyFrameRateCap: 60, proxyQuality: "high" },
} as const;

function MediaSettings() {
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const update = useRendererStore((state) => state.updateProjectSettings);
  if (!session)
    return (
      <Notice size="default">Open a project to configure its media and proxy settings.</Notice>
    );
  const settings = session.settings;

  async function updateProfile(profile: typeof settings.proxyProfile): Promise<void> {
    await update({
      proxyProfile: profile,
      ...(profile === "custom" ? {} : PROXY_PRESETS[profile]),
    });
  }

  return (
    <>
      <SettingsHeading
        icon={<Film size={18} />}
        title="Media & proxies"
        detail="Choose how local edit representations are created for this project"
      />
      <Notice className="mb-5 rounded-lg bg-panel" size="default">
        Balanced is a good starting point. Cloud originals always keep a local proxy for responsive
        editing, and the original is moved to Trash only after both upload and proxy finish.
      </Notice>
      <div className="divide-y divide-border rounded-xl border border-border bg-panel">
        <SettingRow
          title="Automatic proxying"
          detail="Create edit proxies in the background after media is imported."
        >
          <Select
            value={settings.proxyGeneration}
            onChange={(event) =>
              void update({ proxyGeneration: event.target.value as "automatic" | "manual" })
            }
          >
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
          </Select>
        </SettingRow>
        <SettingRow
          title="Proxy profile"
          detail="Controls proxy resolution, frame rate, and quality."
        >
          <Select
            value={settings.proxyProfile}
            onChange={(event) =>
              void updateProfile(event.target.value as typeof settings.proxyProfile)
            }
          >
            <option value="space-saver">Space saver · 960 px / 30 fps</option>
            <option value="balanced">Balanced · 1280 px / up to 60 fps</option>
            <option value="high-quality">High quality · 1920 px / up to 60 fps</option>
            <option value="custom">Custom</option>
          </Select>
        </SettingRow>
        {settings.proxyProfile === "custom" && (
          <>
            <SettingRow
              title="Maximum long edge"
              detail="The largest proxy width or height in pixels."
            >
              <Input
                type="number"
                min={320}
                max={7680}
                value={settings.proxyMaxLongEdge}
                onChange={(event) => void update({ proxyMaxLongEdge: Number(event.target.value) })}
              />
            </SettingRow>
            <SettingRow title="Frame-rate cap" detail="Preserves lower source frame rates.">
              <Select
                value={settings.proxyFrameRateCap}
                onChange={(event) =>
                  void update({ proxyFrameRateCap: Number(event.target.value) as 30 | 60 })
                }
              >
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </Select>
            </SettingRow>
            <SettingRow
              title="Encoding quality"
              detail="Higher quality uses more local cache space."
            >
              <Select
                value={settings.proxyQuality}
                onChange={(event) =>
                  void update({
                    proxyQuality: event.target.value as "low" | "medium" | "high",
                  })
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            </SettingRow>
          </>
        )}
      </div>
    </>
  );
}

function AccountSettings() {
  const account = useRendererStore((state) => state.account);
  const accountHydrated = useRendererStore((state) => state.accountHydrated);
  const beginSignIn = useRendererStore((state) => state.beginAccountSignIn);
  const signOut = useRendererStore((state) => state.signOutAccount);
  const refresh = useRendererStore((state) => state.refreshAccount);
  const [busy, setBusy] = useState<"email" | "google" | "sign-out" | "refresh" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const showLoading = useDelayedBusy(!accountHydrated);

  async function startSignIn(method: "email" | "google"): Promise<void> {
    setBusy(method);
    setMessage(null);
    const result = await beginSignIn(method);
    if (!result.ok) setMessage(result.error);
    setBusy(null);
  }

  async function handleSignOut(): Promise<void> {
    setBusy("sign-out");
    setMessage(null);
    const result = await signOut();
    if (!result.ok) setMessage(result.error);
    setBusy(null);
  }

  async function handleRefresh(): Promise<void> {
    setBusy("refresh");
    await refresh();
    setBusy(null);
  }

  if (!accountHydrated)
    return (
      <div className="min-h-40" aria-busy="true">
        {showLoading && <Skeleton className="h-32 rounded-xl border border-border bg-panel" />}
      </div>
    );

  return (
    <div className="max-w-xl">
      <SettingsHeading
        icon={<User size={18} />}
        title="Account"
        detail="Manage how you sign in to Cinesim"
      />
      {account.status === "signed-in" && account.user ? (
        <div className="rounded-xl border border-border bg-panel p-6">
          <div className="flex items-center gap-4">
            <AccountAvatar user={account.user} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui font-semibold text-primary">{account.user.name}</p>
              <p className="truncate text-ui text-muted">{account.user.email}</p>
              <p className="mt-1 flex items-center gap-1 text-ui-xs text-emerald-500">
                <Check size={12} /> Email verified
              </p>
            </div>
          </div>
          <div className="mt-6 flex justify-end border-t border-border pt-5">
            <button
              className="h-8 rounded-md border border-border px-3 text-ui text-secondary hover:bg-surface hover:text-primary disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void handleSignOut()}
            >
              {busy === "sign-out" ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      ) : !account.serviceAvailable ? (
        <div className="rounded-xl border border-border bg-panel p-6">
          <p className="text-ui font-semibold text-primary">Account service unavailable</p>
          <p className="mt-1 max-w-md text-ui leading-5 text-muted">
            Local editing still works normally. Try again when the authentication service is
            available.
          </p>
          {account.detail && (
            <p className="mt-3 text-ui-xs leading-5 text-amber-500">{account.detail}</p>
          )}
          <button
            className="mt-5 flex h-8 items-center gap-1.5 rounded-md border border-border bg-panel px-3 text-ui text-secondary hover:bg-surface hover:text-primary disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={13} className={cn(busy === "refresh" && "animate-spin")} />
            {busy === "refresh" ? "Checking…" : "Try again"}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-panel p-6">
          <p className="text-ui font-semibold text-primary">Sign in to Cinesim</p>
          <div className="mt-6 space-y-2">
            {account.googleSignIn && (
              <button
                className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent px-3 text-ui font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void startSignIn("google")}
              >
                <GoogleMark className="size-4" />
                {busy === "google" ? "Opening Google…" : "Continue with Google"}
              </button>
            )}
            <button
              className={cn(
                "h-9 w-full rounded-md px-3 text-ui font-medium disabled:opacity-50",
                account.googleSignIn
                  ? "border border-border bg-panel text-primary hover:bg-surface"
                  : "bg-accent text-on-accent hover:bg-accent-hover",
              )}
              disabled={busy !== null}
              onClick={() => void startSignIn("email")}
            >
              {busy === "email" ? "Opening browser…" : "Sign in with email"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <Notice className="mt-4 rounded-lg bg-panel" size="default">
          {message}
        </Notice>
      )}
    </div>
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
  const cachedSettings = cachedAgentSettings();
  const [settings, setSettings] = useState<AgentSettings | null>(cachedSettings);
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
      const nextStatuses = await window.cinesim.refreshAgentProviders();
      cacheAgentProviders(nextStatuses);
      setStatuses(nextStatuses);
      const nextSettings = await window.cinesim.getAgentSettings();
      cacheAgentSettings(nextSettings);
      setSettings(nextSettings);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not inspect local agents");
    }
    setBusy(false);
  }

  useEffect(() => {
    void (async () => {
      const value = await window.cinesim.getAgentSettings();
      cacheAgentSettings(value);
      setSettings(value);
      setProvider(value.defaultProvider);
      await refresh();
    })();
  }, []);

  async function updateProvider(input: {
    executablePath?: string;
    model?: string;
    effort?: AgentEffort;
    permissionMode?: AgentPermissionMode;
  }): Promise<void> {
    const next = await window.cinesim.updateAgentSettings({ provider, ...input });
    cacheAgentSettings(next);
    setSettings(next);
  }

  async function chooseExecutable(): Promise<void> {
    const next = await window.cinesim.chooseAgentExecutable(provider);
    if (next) {
      cacheAgentSettings(next);
      setSettings(next);
      await refresh();
    }
  }

  async function makeDefaultProvider(): Promise<void> {
    const next = await window.cinesim.updateAgentSettings({ defaultProvider: provider });
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

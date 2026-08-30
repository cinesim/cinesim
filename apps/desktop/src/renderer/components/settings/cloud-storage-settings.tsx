import { useCallback, useEffect, useState } from "react";
import { Cloud, Database, RefreshCw } from "@cinesim/ui";
import { cn, Notice, Select } from "@cinesim/ui";
import type { CloudStorageUsage } from "../../../shared/contracts";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { SettingsHeading } from "./settings-layout";

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

export function CloudStorageSettings() {
  const account = useRendererStore((state) => state.account);
  const transfers = useRendererStore((state) => state.cloudTransfers);
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const reportError = useRendererStore((state) => state.reportError);
  const [usageState, setUsageState] = useState<CloudUsageState>({ status: "idle" });
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const usage = cloudUsage(usageState);
  const loading = usageState.status === "loading";

  const refresh = useCallback(async (): Promise<void> => {
    if (account.status !== "signed-in") return;
    setUsageState({ status: "loading", previous: usage });
    try {
      setUsageState({ status: "ready", usage: await window.cinesim.cloud.getUsage() });
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Cloud storage usage is unavailable";
      setUsageState({
        status: "failed",
        previous: usage,
        error: message,
      });
      reportError(message);
    }
  }, [account.status, reportError, usage]);

  useEffect(() => {
    if (account.status !== "signed-in") return;

    let active = true;
    void window.cinesim.cloud
      .getUsage()
      .then((nextUsage) => {
        if (!active) return;
        setUsageState({ status: "ready", usage: nextUsage });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        const message =
          caught instanceof Error ? caught.message : "Cloud storage usage is unavailable";
        setUsageState((current) => ({
          status: "failed",
          previous: cloudUsage(current),
          error: message,
        }));
        reportError(message);
      });

    return () => {
      active = false;
    };
  }, [account.status, reportError, transfers]);

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
      if (operation === "trash") await window.cinesim.cloud.trashAssets([id]);
      else if (operation === "restore") await window.cinesim.cloud.restoreAsset(id);
      else await window.cinesim.cloud.deleteAsset(id);
      setConfirmDelete(null);
      await refresh();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "The cloud asset could not be updated";
      setUsageState({
        status: "failed",
        previous: usage,
        error: message,
      });
      reportError(message);
    }
    setBusyAssetId(null);
  }

  async function configureAddon(addonBytes: number): Promise<void> {
    setUsageState({ status: "loading", previous: usage });
    try {
      setUsageState({
        status: "ready",
        usage: await window.cinesim.cloud.configureAddon(addonBytes),
      });
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "The storage allowance could not change";
      setUsageState({
        status: "failed",
        previous: usage,
        error: message,
      });
      reportError(message);
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

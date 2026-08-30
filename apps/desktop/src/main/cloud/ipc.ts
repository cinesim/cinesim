import type { CloudMediaManager } from "./manager";
import { cloudContracts } from "./contracts";
import { registerIpcHandler } from "../app/secure-ipc";
import { requireUserIntent } from "../app/user-intent";

export function registerCloudIpc(manager: CloudMediaManager): void {
  registerIpcHandler(cloudContracts.usage, () => manager.usage());
  registerIpcHandler(cloudContracts.configureAddon, async ({ addonBytes }) => {
    await requireUserIntent({
      title: "Change cloud storage allowance?",
      message: "Confirm this account storage allowance change.",
      detail: `Requested add-on allowance: ${addonBytes.toLocaleString()} bytes. This may change billing or account limits.`,
      confirmLabel: "Confirm allowance",
    });
    return manager.configureAddon(addonBytes);
  });
  registerIpcHandler(cloudContracts.transfers, () => manager.snapshots());
  registerIpcHandler(cloudContracts.retry, ({ assetId }) => manager.retry(assetId));
  registerIpcHandler(cloudContracts.cancel, ({ assetId }) => manager.cancel(assetId));
  registerIpcHandler(cloudContracts.downloadedOriginals, () => manager.downloadedOriginals());
  registerIpcHandler(cloudContracts.keepDownloaded, ({ assetId }) =>
    manager.keepDownloaded(assetId),
  );
  registerIpcHandler(cloudContracts.removeDownload, ({ assetId }) =>
    manager.removeDownload(assetId),
  );
  registerIpcHandler(cloudContracts.trashAssets, ({ cloudAssetIds }) =>
    manager.trashAssets(cloudAssetIds),
  );
  registerIpcHandler(cloudContracts.restoreAsset, ({ cloudAssetId }) =>
    manager.restoreAsset(cloudAssetId),
  );
  registerIpcHandler(cloudContracts.deleteAsset, async ({ cloudAssetId }) => {
    await requireUserIntent({
      title: "Delete cloud asset permanently?",
      message: "Permanently delete this asset from Cinesim Cloud?",
      detail: `Asset: ${cloudAssetId}\nThis cannot be undone.`,
      confirmLabel: "Delete permanently",
    });
    return manager.deleteAsset(cloudAssetId);
  });
}

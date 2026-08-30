import type { CloudMediaManager } from "./manager";
import { registerIpcHandler } from "../app/secure-ipc";
import { z } from "zod";
import { assetIdSchema, cloudAssetIdSchema } from "@cinesim/core";
import { requireUserIntent } from "../app/user-intent";

const cloudAssetIdsSchema = z.array(cloudAssetIdSchema).max(100);

export function registerCloudIpc(manager: CloudMediaManager): void {
  registerIpcHandler("cloud:usage", () => manager.usage());
  registerIpcHandler("cloud:configure-addon", async (value: unknown) => {
    const addonBytes = z.number().int().nonnegative().safe().parse(value);
    await requireUserIntent({
      title: "Change cloud storage allowance?",
      message: "Confirm this account storage allowance change.",
      detail: `Requested add-on allowance: ${addonBytes.toLocaleString()} bytes. This may change billing or account limits.`,
      confirmLabel: "Confirm allowance",
    });
    return manager.configureAddon(addonBytes);
  });
  registerIpcHandler("cloud:transfers", () => manager.snapshots());
  registerIpcHandler("cloud:retry", (value: unknown) => manager.retry(assetIdSchema.parse(value)));
  registerIpcHandler("cloud:cancel", (value: unknown) =>
    manager.cancel(assetIdSchema.parse(value)),
  );
  registerIpcHandler("cloud:downloaded-originals", () => manager.downloadedOriginals());
  registerIpcHandler("cloud:keep-downloaded", (value: unknown) =>
    manager.keepDownloaded(assetIdSchema.parse(value)),
  );
  registerIpcHandler("cloud:remove-download", (value: unknown) =>
    manager.removeDownload(assetIdSchema.parse(value)),
  );
  registerIpcHandler("cloud:trash-assets", (value: unknown) => {
    return manager.trashAssets(cloudAssetIdsSchema.parse(value));
  });
  registerIpcHandler("cloud:restore-asset", (value: unknown) =>
    manager.restoreAsset(cloudAssetIdSchema.parse(value)),
  );
  registerIpcHandler("cloud:delete-asset", async (value: unknown) => {
    const cloudAssetId = cloudAssetIdSchema.parse(value);
    await requireUserIntent({
      title: "Delete cloud asset permanently?",
      message: "Permanently delete this asset from Cinesim Cloud?",
      detail: `Asset: ${cloudAssetId}\nThis cannot be undone.`,
      confirmLabel: "Delete permanently",
    });
    return manager.deleteAsset(cloudAssetId);
  });
}

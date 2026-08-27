import { ipcMain } from "electron";
import type { CloudMediaManager } from "./manager";

function assetId(value: unknown): string {
  if (typeof value !== "string" || !/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))
    throw new Error("Invalid asset ID");
  return value;
}

function cloudAssetId(value: unknown): string {
  if (typeof value !== "string" || !/^cloud_asset_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value))
    throw new Error("Invalid cloud asset ID");
  return value;
}

export function registerCloudIpc(manager: CloudMediaManager): void {
  ipcMain.handle("cloud:usage", () => manager.usage());
  ipcMain.handle("cloud:transfers", () => manager.snapshots());
  ipcMain.handle("cloud:store-assets", (_event, value: unknown) => {
    if (!Array.isArray(value)) throw new Error("Invalid cloud storage request");
    return manager.queue(value.map(assetId));
  });
  ipcMain.handle("cloud:retry", (_event, value: unknown) => manager.retry(assetId(value)));
  ipcMain.handle("cloud:cancel", (_event, value: unknown) => manager.cancel(assetId(value)));
  ipcMain.handle("cloud:trash-assets", (_event, value: unknown) => {
    if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid cloud asset request");
    return manager.trashAssets(value.map(cloudAssetId));
  });
  ipcMain.handle("cloud:restore-asset", (_event, value: unknown) =>
    manager.restoreAsset(cloudAssetId(value)),
  );
  ipcMain.handle("cloud:delete-asset", (_event, value: unknown) =>
    manager.deleteAsset(cloudAssetId(value)),
  );
}

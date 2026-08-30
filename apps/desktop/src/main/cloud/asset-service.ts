import type { CloudStorageUsage } from "../../shared/contracts";
import type { CloudStorageGateway } from "./gateway";

export class CloudAssetService {
  constructor(private readonly gateway: CloudStorageGateway) {}

  usage(): Promise<CloudStorageUsage> {
    return this.gateway.usage();
  }

  configureAddon(addonBytes: number): Promise<CloudStorageUsage> {
    if (!Number.isSafeInteger(addonBytes) || addonBytes < 0)
      throw new Error("Invalid storage allowance");
    return this.gateway.configureAddon(addonBytes);
  }

  async trash(cloudAssetIds: readonly string[]): Promise<void> {
    await Promise.all(cloudAssetIds.map((id) => this.gateway.trash(id)));
  }

  restore(cloudAssetId: string): Promise<void> {
    return this.gateway.restore(cloudAssetId);
  }

  delete(cloudAssetId: string): Promise<void> {
    return this.gateway.delete(cloudAssetId);
  }
}

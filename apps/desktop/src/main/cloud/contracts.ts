import { z } from "zod";
import { assetIdSchema, cloudAssetIdSchema } from "@cinesim/core";
import type { AssetId, CloudAssetId } from "@cinesim/core";
import type { CloudStorageUsage, CloudTransferSnapshot } from "../../shared/contracts";
import { invokeChannels } from "../../shared/contracts/channels";
import { defineInvokeContract } from "../app/ipc-contract";
import { emptyRequestSchema } from "../app/ipc-schemas";

const cloudAssetIdsSchema = z.array(cloudAssetIdSchema).max(100);

export const cloudContracts = {
  usage: defineInvokeContract<[], CloudStorageUsage>({
    channel: invokeChannels.cloud.usage,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  configureAddon: defineInvokeContract<[{ addonBytes: number }], CloudStorageUsage>({
    channel: invokeChannels.cloud.configureAddon,
    request: z.tuple([z.object({ addonBytes: z.number().int().nonnegative().safe() }).strict()]),
    privilege: "account",
  }),
  transfers: defineInvokeContract<[], CloudTransferSnapshot[]>({
    channel: invokeChannels.cloud.transfers,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  retry: assetTransferContract(invokeChannels.cloud.retry),
  cancel: assetTransferContract(invokeChannels.cloud.cancel),
  downloadedOriginals: defineInvokeContract<[], string[]>({
    channel: invokeChannels.cloud.downloadedOriginals,
    request: emptyRequestSchema,
    privilege: "read",
  }),
  keepDownloaded: assetStringListContract(invokeChannels.cloud.keepDownloaded),
  removeDownload: assetStringListContract(invokeChannels.cloud.removeDownload),
  trashAssets: defineInvokeContract<[{ cloudAssetIds: CloudAssetId[] }], void>({
    channel: invokeChannels.cloud.trashAssets,
    request: z.tuple([z.object({ cloudAssetIds: cloudAssetIdsSchema }).strict()]),
    privilege: "reversible-mutation",
  }),
  restoreAsset: cloudAssetMutationContract(
    invokeChannels.cloud.restoreAsset,
    "reversible-mutation",
  ),
  deleteAsset: cloudAssetMutationContract(invokeChannels.cloud.deleteAsset, "destructive"),
} as const;

function assetTransferContract(channel: string) {
  return defineInvokeContract<[{ assetId: AssetId }], CloudTransferSnapshot[]>({
    channel,
    request: z.tuple([z.object({ assetId: assetIdSchema }).strict()]),
    privilege: "reversible-mutation",
  });
}

function assetStringListContract(channel: string) {
  return defineInvokeContract<[{ assetId: AssetId }], string[]>({
    channel,
    request: z.tuple([z.object({ assetId: assetIdSchema }).strict()]),
    privilege: "reversible-mutation",
  });
}

function cloudAssetMutationContract(
  channel: string,
  privilege: "reversible-mutation" | "destructive",
) {
  return defineInvokeContract<[{ cloudAssetId: CloudAssetId }], void>({
    channel,
    request: z.tuple([z.object({ cloudAssetId: cloudAssetIdSchema }).strict()]),
    privilege,
  });
}

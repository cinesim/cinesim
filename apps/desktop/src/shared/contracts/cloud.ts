export type CloudTransferState =
  | "waiting-for-cloud"
  | "preparing"
  | "uploading"
  | "waiting-for-proxy"
  | "paused"
  | "failed"
  | "complete";

export interface CloudTransferSnapshot {
  assetId: string;
  cloudAssetId: string | null;
  name: string;
  bytes: number;
  uploadedBytes: number;
  state: CloudTransferState;
  error: string | null;
}

export interface CloudStorageAssetUsage {
  id: string;
  clientAssetId: string;
  name: string;
  kind: "video" | "audio" | "image";
  bytes: number;
  state: "preparing" | "uploading" | "ready" | "failed" | "trashed";
  trashedAt: string | null;
}

export interface CloudStorageProjectUsage {
  id: string;
  clientProjectId: string;
  name: string;
  usedBytes: number;
  reservedBytes: number;
  assets: CloudStorageAssetUsage[];
}

export interface CloudStorageUsage {
  includedBytes: number;
  addonBytes: number;
  usedBytes: number;
  reservedBytes: number;
  addonOptionsBytes: number[];
  projects: CloudStorageProjectUsage[];
}

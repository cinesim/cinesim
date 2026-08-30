import type { Asset, AssetId, Project } from "@cinesim/core";
import type { CloudTransferSnapshot } from "../../../shared/api";

export interface Point {
  x: number;
  y: number;
}

export interface Rectangle extends Point {
  height: number;
  width: number;
}

export interface Bounds {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface SelectionModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

interface SelectionChange {
  anchor: AssetId | null;
  selectedIds: Set<AssetId>;
}

export interface AssetUsageSummary {
  affectedTimelineCount: number;
  clipCount: number;
  lockedTrackName: string | null;
}

export type AssetStorageStatus =
  | "cloud-downloaded"
  | "cloud-original"
  | "local"
  | "paused"
  | "preparing"
  | "upload-failed"
  | "uploading"
  | "waiting-for-cloud"
  | "waiting-for-proxy";

export interface AssetStoragePresentation {
  kind: AssetStorageStatus;
  label: string;
}

export function nextTimelineName(project: Project): string {
  const ordinals = project.sequences
    .map((sequence) => /^Timeline (\d+)$/.exec(sequence.name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  return `Timeline ${Math.max(1, ...ordinals) + 1}`;
}

export function rectangleFromPoints(origin: Point, target: Point): Rectangle {
  return {
    x: Math.min(origin.x, target.x),
    y: Math.min(origin.y, target.y),
    width: Math.abs(target.x - origin.x),
    height: Math.abs(target.y - origin.y),
  };
}

export function rectanglesIntersect(selection: Rectangle, target: Bounds): boolean {
  return (
    selection.x < target.right &&
    selection.x + selection.width > target.left &&
    selection.y < target.bottom &&
    selection.y + selection.height > target.top
  );
}

export function updateAssetSelection(
  selectedIds: ReadonlySet<AssetId>,
  visibleIds: readonly AssetId[],
  assetId: AssetId,
  anchor: AssetId | null,
  modifiers: SelectionModifiers,
): SelectionChange {
  if (modifiers.shiftKey && anchor) {
    const anchorIndex = visibleIds.indexOf(anchor);
    const targetIndex = visibleIds.indexOf(assetId);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      return { anchor, selectedIds: new Set(visibleIds.slice(start, end + 1)) };
    }
  }

  if (modifiers.metaKey || modifiers.ctrlKey) {
    const next = new Set(selectedIds);
    if (next.has(assetId)) next.delete(assetId);
    else next.add(assetId);
    return { anchor: assetId, selectedIds: next };
  }

  return { anchor: assetId, selectedIds: new Set([assetId]) };
}

export function summarizeAssetUsage(
  project: Project,
  selectedIds: ReadonlySet<AssetId>,
): AssetUsageSummary {
  let clipCount = 0;
  let lockedTrackName: string | null = null;
  const affectedTimelineIds = new Set<string>();

  for (const sequence of project.sequences) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (!selectedIds.has(clip.assetId)) continue;
        clipCount += 1;
        affectedTimelineIds.add(sequence.id);
        if (track.locked && !lockedTrackName) lockedTrackName = track.name;
      }
    }
  }

  return {
    affectedTimelineCount: affectedTimelineIds.size,
    clipCount,
    lockedTrackName,
  };
}

export function assetStoragePresentation(
  asset: Asset,
  transfer: CloudTransferSnapshot | undefined,
  originalDownloaded: boolean,
): AssetStoragePresentation {
  if (asset.source.kind === "cloud") {
    return originalDownloaded
      ? { kind: "cloud-downloaded", label: "Cloud original · downloaded" }
      : { kind: "cloud-original", label: "Cloud original" };
  }

  switch (transfer?.state) {
    case "waiting-for-cloud":
      return { kind: "waiting-for-cloud", label: "Waiting for cloud" };
    case "failed":
      return { kind: "upload-failed", label: "Cloud upload failed" };
    case "paused":
      return { kind: "paused", label: "Cloud upload paused" };
    case "waiting-for-proxy":
      return { kind: "waiting-for-proxy", label: "Cloud ready · finishing proxy" };
    case "preparing":
      return { kind: "preparing", label: "Preparing cloud upload" };
    case "uploading":
      return {
        kind: "uploading",
        label: `${Math.round((transfer.uploadedBytes / Math.max(1, transfer.bytes)) * 100)}% uploaded`,
      };
    default:
      return { kind: "local", label: "Local original" };
  }
}

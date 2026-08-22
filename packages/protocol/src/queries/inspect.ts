import { clipEndUs, getSequence, sequenceDurationUs } from "@cinesim/core";
import type { AssetId, Project } from "@cinesim/core";

export function inspectProject(project: Project) {
  const sequence = getSequence(project);
  return {
    version: project.version,
    id: project.id,
    name: project.name,
    activeSequenceId: project.activeSequenceId,
    durationUs: sequenceDurationUs(sequence),
    assetCount: project.assets.length,
    sequenceCount: project.sequences.length,
    trackCount: sequence.tracks.length,
    clipCount: sequence.tracks.reduce((count, track) => count + track.clips.length, 0),
  };
}

export function listAssets(project: Project) {
  return project.assets.map((asset) => ({ ...asset }));
}

export function inspectAsset(project: Project, assetId: AssetId) {
  const asset = project.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);
  return structuredClone(asset);
}

export function inspectTimeline(project: Project) {
  const sequence = getSequence(project);
  return {
    sequence: {
      id: sequence.id,
      name: sequence.name,
      width: sequence.width,
      height: sequence.height,
      frameRate: sequence.frameRate,
      durationUs: sequenceDurationUs(sequence),
    },
    tracks: sequence.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      muted: track.muted,
      locked: track.locked,
      clips: track.clips.map((clip) => ({ ...clip, timelineEndUs: clipEndUs(clip) })),
    })),
  };
}

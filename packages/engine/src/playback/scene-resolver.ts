import { clipEndUs, getSequence } from "@cinesim/core";
import type { Asset, Clip, Project, TimeUs, Track } from "@cinesim/core";

export interface ResolvedLayer {
  asset: Asset;
  clip: Clip;
  track: Track;
  sourceTimeUs: TimeUs;
}

export function resolveScene(project: Project, timelineTimeUs: TimeUs): ResolvedLayer[] {
  const sequence = getSequence(project);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const layers: ResolvedLayer[] = [];
  // Canonical track order matches the timeline UI: index 0 is the uppermost
  // track. The compositor blends later draws over earlier ones, so resolve
  // visual tracks from bottom to top.
  for (const track of sequence.tracks.toReversed()) {
    if (track.muted || track.kind === "audio") continue;
    const clip = track.clips.find(
      (candidate) =>
        timelineTimeUs >= candidate.timelineStartUs && timelineTimeUs < clipEndUs(candidate),
    );
    if (!clip) continue;
    const asset = assets.get(clip.assetId);
    if (!asset) continue;
    layers.push({
      asset,
      clip,
      track,
      sourceTimeUs: clip.sourceStartUs + timelineTimeUs - clip.timelineStartUs,
    });
  }
  return layers;
}

export function findUpcomingLayers(
  project: Project,
  timelineTimeUs: TimeUs,
  lookAheadUs = 1_000_000,
): ResolvedLayer[] {
  const sequence = getSequence(project);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const end = timelineTimeUs + lookAheadUs;
  return sequence.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.timelineStartUs > timelineTimeUs && clip.timelineStartUs <= end)
      .flatMap((clip) => {
        const asset = assets.get(clip.assetId);
        return asset ? [{ asset, clip, track, sourceTimeUs: clip.sourceStartUs }] : [];
      }),
  );
}

import { clipDurationUs, clipEndUs, findClip, getSequence } from "@cinesim/core";
import type { Asset, ClipId, Project, TimeUs, Track, TrackId } from "@cinesim/core";

export type TimelineDropKind = "asset" | "clip";

export interface TimelineDropProposal {
  kind: TimelineDropKind;
  assetId: Asset["id"];
  clipId?: ClipId;
  trackId: TrackId;
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
  valid: boolean;
  reason?: "incompatible-track" | "locked-track" | "overlap";
  snapped: boolean;
}

interface ProposalOptions {
  snapCandidatesUs?: readonly TimeUs[];
  snapToleranceUs?: TimeUs;
}

export function trackAcceptsAsset(track: Pick<Track, "kind">, asset: Pick<Asset, "kind">): boolean {
  if (asset.kind === "audio") return track.kind === "audio";
  return track.kind === "video" || track.kind === "overlay";
}

export function quantizeToFrame(timeUs: TimeUs, frameRate: number): TimeUs {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return Math.max(0, Math.round(timeUs));
  return Math.max(
    0,
    Math.round(Math.round((timeUs * frameRate) / 1_000_000) * (1_000_000 / frameRate)),
  );
}

export function snapTimelineTime(
  rawTimeUs: TimeUs,
  frameRate: number,
  candidatesUs: readonly TimeUs[],
  toleranceUs: TimeUs,
): { timeUs: TimeUs; snapped: boolean } {
  const frameTimeUs = quantizeToFrame(rawTimeUs, frameRate);
  let nearest: TimeUs | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidatesUs) {
    const distance = Math.abs(candidate - frameTimeUs);
    if (distance <= toleranceUs && distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest === null
    ? { timeUs: frameTimeUs, snapped: frameTimeUs !== Math.round(rawTimeUs) }
    : { timeUs: Math.max(0, nearest), snapped: true };
}

export function timelineSnapCandidates(project: Project, ignoredClipId?: ClipId): TimeUs[] {
  const sequence = getSequence(project);
  return [
    0,
    ...sequence.tracks.flatMap((track) =>
      track.clips
        .filter((clip) => clip.id !== ignoredClipId)
        .flatMap((clip) => [clip.timelineStartUs, clipEndUs(clip)]),
    ),
  ].toSorted((left, right) => left - right);
}

function validation(
  project: Project,
  trackId: TrackId,
  asset: Asset,
  startUs: TimeUs,
  endUs: TimeUs,
  ignoredClipId?: ClipId,
): Pick<TimelineDropProposal, "valid" | "reason"> {
  const track = getSequence(project).tracks.find((candidate) => candidate.id === trackId);
  if (!track || !trackAcceptsAsset(track, asset))
    return { valid: false, reason: "incompatible-track" };
  if (track.locked) return { valid: false, reason: "locked-track" };
  if (
    track.clips.some(
      (clip) =>
        clip.id !== ignoredClipId && startUs < clipEndUs(clip) && endUs > clip.timelineStartUs,
    )
  )
    return { valid: false, reason: "overlap" };
  return { valid: true };
}

export function proposeAssetDrop(
  project: Project,
  assetId: Asset["id"],
  trackId: TrackId,
  rawTimelineStartUs: TimeUs,
  options: ProposalOptions = {},
): TimelineDropProposal | null {
  const asset = project.assets.find((candidate) => candidate.id === assetId);
  if (!asset) return null;
  const sequence = getSequence(project);
  const snapped = snapTimelineTime(
    rawTimelineStartUs,
    sequence.frameRate,
    options.snapCandidatesUs ?? timelineSnapCandidates(project),
    options.snapToleranceUs ?? 0,
  );
  const timelineEndUs = snapped.timeUs + asset.durationUs;
  return {
    kind: "asset",
    assetId,
    trackId,
    timelineStartUs: snapped.timeUs,
    timelineEndUs,
    ...validation(project, trackId, asset, snapped.timeUs, timelineEndUs),
    snapped: snapped.snapped,
  };
}

export function proposeClipMove(
  project: Project,
  clipId: ClipId,
  trackId: TrackId,
  rawTimelineStartUs: TimeUs,
  options: ProposalOptions = {},
): TimelineDropProposal | null {
  let location: ReturnType<typeof findClip>;
  try {
    location = findClip(project, clipId);
  } catch {
    return null;
  }
  const asset = project.assets.find((candidate) => candidate.id === location.clip.assetId);
  if (!asset) return null;
  const sequence = getSequence(project);
  const snapped = snapTimelineTime(
    rawTimelineStartUs,
    sequence.frameRate,
    options.snapCandidatesUs ?? timelineSnapCandidates(project, clipId),
    options.snapToleranceUs ?? 0,
  );
  const timelineEndUs = snapped.timeUs + clipDurationUs(location.clip);
  return {
    kind: "clip",
    assetId: asset.id,
    clipId,
    trackId,
    timelineStartUs: snapped.timeUs,
    timelineEndUs,
    ...validation(project, trackId, asset, snapped.timeUs, timelineEndUs, clipId),
    snapped: snapped.snapped,
  };
}

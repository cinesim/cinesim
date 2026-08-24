import {
  clipDurationUs,
  clipEndUs,
  findClip,
  getSequence,
  isAssetCompatibleWithTrack,
  isAssetMediaCompatibleWithTrack,
} from "@cinesim/core";
import type { Asset, ClipId, EditorCommand, Project, TimeUs, TrackId } from "@cinesim/core";

export type TimelineDropKind = "asset" | "clip";

export interface TimelineDropProposal {
  kind: TimelineDropKind;
  assetId: Asset["id"];
  clipId?: ClipId;
  trackId: TrackId;
  audioTrackId?: TrackId;
  timelineStartUs: TimeUs;
  timelineEndUs: TimeUs;
  valid: boolean;
  reason?: "incompatible-track" | "locked-track" | "overlap" | "audio-track-unavailable";
  snapped: boolean;
}

export type TimelineDragInput =
  | { kind: "asset"; assetId: Asset["id"] }
  | { kind: "clip"; clipId: ClipId; trackId: TrackId };

interface ProposalOptions {
  snapCandidatesUs?: readonly TimeUs[];
  snapToleranceUs?: TimeUs;
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
  const linkedClipId = ignoredClipId
    ? sequence.tracks.flatMap((track) => track.clips).find((clip) => clip.id === ignoredClipId)
        ?.linkedClipId
    : undefined;
  return [
    0,
    ...sequence.tracks.flatMap((track) =>
      track.clips
        .filter((clip) => clip.id !== ignoredClipId && clip.id !== linkedClipId)
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
  mediaKind?: "video" | "audio",
): Pick<TimelineDropProposal, "valid" | "reason"> {
  const track = getSequence(project).tracks.find((candidate) => candidate.id === trackId);
  const compatible =
    track &&
    (mediaKind
      ? isAssetMediaCompatibleWithTrack(asset, mediaKind, track.kind)
      : isAssetCompatibleWithTrack(asset.kind, track.kind));
  if (!track || !compatible) return { valid: false, reason: "incompatible-track" };
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

export function isNoopClipMove(project: Project, proposal: TimelineDropProposal): boolean {
  if (proposal.kind !== "clip" || !proposal.clipId) return false;
  try {
    const location = findClip(project, proposal.clipId);
    return (
      location.track.id === proposal.trackId &&
      location.clip.timelineStartUs === proposal.timelineStartUs
    );
  } catch {
    return false;
  }
}

export function commandForTimelineDrop(
  project: Project,
  input: TimelineDragInput | null,
  proposal: TimelineDropProposal | null,
): EditorCommand | null {
  if (!input || !proposal?.valid || input.kind !== proposal.kind) return null;
  if (input.kind === "asset") {
    if (input.assetId !== proposal.assetId) return null;
    return {
      type: "clip.add",
      trackId: proposal.trackId,
      assetId: input.assetId,
      timelineStartUs: proposal.timelineStartUs,
      ...(proposal.audioTrackId ? { audioTrackId: proposal.audioTrackId } : {}),
    };
  }
  if (input.clipId !== proposal.clipId || isNoopClipMove(project, proposal)) return null;
  return {
    type: "clip.move",
    clipId: input.clipId,
    trackId: proposal.trackId,
    timelineStartUs: proposal.timelineStartUs,
  };
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
  const primaryValidation = validation(project, trackId, asset, snapped.timeUs, timelineEndUs);
  const audioTrack =
    asset.kind === "video" && asset.hasAudio === true
      ? sequence.tracks.find(
          (track) =>
            track.kind === "audio" &&
            !track.locked &&
            !track.clips.some(
              (clip) => snapped.timeUs < clipEndUs(clip) && timelineEndUs > clip.timelineStartUs,
            ),
        )
      : null;
  const requiresAudioTrack = asset.kind === "video" && asset.hasAudio === true;
  return {
    kind: "asset",
    assetId,
    trackId,
    timelineStartUs: snapped.timeUs,
    timelineEndUs,
    ...primaryValidation,
    ...(audioTrack ? { audioTrackId: audioTrack.id } : {}),
    ...(primaryValidation.valid && requiresAudioTrack && !audioTrack
      ? { valid: false, reason: "audio-track-unavailable" as const }
      : {}),
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
  const primaryValidation = validation(
    project,
    trackId,
    asset,
    snapped.timeUs,
    timelineEndUs,
    clipId,
    location.clip.mediaKind,
  );
  const linked = location.clip.linkedClipId ? findClip(project, location.clip.linkedClipId) : null;
  const deltaUs = snapped.timeUs - location.clip.timelineStartUs;
  const linkedValidation = linked
    ? validation(
        project,
        linked.track.id,
        asset,
        linked.clip.timelineStartUs + deltaUs,
        clipEndUs(linked.clip) + deltaUs,
        linked.clip.id,
        linked.clip.mediaKind,
      )
    : null;
  return {
    kind: "clip",
    assetId: asset.id,
    clipId,
    trackId,
    timelineStartUs: snapped.timeUs,
    timelineEndUs,
    ...(primaryValidation.valid && linkedValidation ? linkedValidation : primaryValidation),
    snapped: snapped.snapped,
  };
}

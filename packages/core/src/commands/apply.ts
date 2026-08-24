import { nextId } from "../ids";
import type { ClipId, SequenceId, TrackId } from "../ids";
import {
  canSplitClipAt,
  clipEndUs,
  DEFAULT_TRANSFORM,
  isAssetCompatibleWithTrack,
} from "../project/types";
import type { Asset, Clip, Project, Sequence, Track } from "../project/types";
import {
  findClip,
  findSequenceForTrack,
  findTrack,
  getSequence,
  getTrack,
} from "../project/selectors";
import type { TrackLocation } from "../project/selectors";
import { CommandError } from "./types";
import type { CommandResult, EditorCommand } from "./types";

const clone = (project: Project): Project => structuredClone(project);

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommandError(
      "INVALID_TIME",
      `${label} must be a non-negative integer number of microseconds`,
    );
  }
}

function sortClips(track: Track): void {
  track.clips.sort((left, right) =>
    left.timelineStartUs === right.timelineStartUs
      ? left.id.localeCompare(right.id)
      : left.timelineStartUs - right.timelineStartUs,
  );
}

function assertNoOverlap(track: Track, candidate: Clip, ignoredId?: ClipId): void {
  const candidateEnd = clipEndUs(candidate);
  const collision = track.clips.find(
    (clip) =>
      clip.id !== ignoredId &&
      candidate.timelineStartUs < clipEndUs(clip) &&
      candidateEnd > clip.timelineStartUs,
  );
  if (collision) {
    throw new CommandError(
      "CLIP_OVERLAP",
      `${candidate.id} overlaps ${collision.id} on ${track.id}`,
    );
  }
}

function allClipIds(project: Project): string[] {
  return project.sequences.flatMap((sequence) =>
    sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
}

function allTrackIds(project: Project): string[] {
  return project.sequences.flatMap((sequence) => sequence.tracks.map((track) => track.id));
}

function requireSequence(project: Project, sequenceId: SequenceId): Sequence {
  try {
    return getSequence(project, sequenceId);
  } catch {
    throw new CommandError("SEQUENCE_NOT_FOUND", `Sequence not found: ${sequenceId}`);
  }
}

function requireTrackLocation(project: Project, trackId: TrackId): TrackLocation {
  try {
    return findTrack(project, trackId);
  } catch {
    throw new CommandError("TRACK_NOT_FOUND", `Track not found: ${trackId}`);
  }
}

function assertTrackName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new CommandError("INVALID_TRACK_NAME", "Track name cannot be empty");
  return normalized;
}

function defaultTrackName(sequence: Sequence, kind: Track["kind"]): string {
  const label = kind === "audio" ? "Audio" : kind === "overlay" ? "Overlay" : "Video";
  const pattern = new RegExp(`^${label} (\\d+)$`);
  const highestOrdinal = sequence.tracks.reduce((highest, track) => {
    const match = pattern.exec(track.name);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `${label} ${highestOrdinal + 1}`;
}

function assertAssetTrackCompatibility(asset: Asset, track: Track): void {
  if (isAssetCompatibleWithTrack(asset.kind, track.kind)) return;
  const compatibleTracks = asset.kind === "audio" ? "audio" : "video or overlay";
  throw new CommandError(
    "INCOMPATIBLE_TRACK",
    `${asset.kind} asset ${asset.id} can only be placed on ${compatibleTracks} tracks`,
  );
}

function result(
  project: Project,
  command: EditorCommand,
  summary: string,
  changedIds: string[],
  createdIds: string[] = [],
): CommandResult {
  return { project, command, summary, changedIds, createdIds };
}

export function applyCommand(inputProject: Project, command: EditorCommand): CommandResult {
  const project = clone(inputProject);

  switch (command.type) {
    case "asset.import": {
      if (project.assets.some((asset) => asset.id === command.asset.id)) {
        throw new CommandError("DUPLICATE_ID", `Asset already exists: ${command.asset.id}`);
      }
      assertTime(command.asset.durationUs, "durationUs");
      project.assets.push(structuredClone(command.asset));
      project.assets.sort((left, right) => left.id.localeCompare(right.id));
      return result(
        project,
        command,
        `Imported ${command.asset.name}`,
        [command.asset.id],
        [command.asset.id],
      );
    }

    case "track.add": {
      const sequence = requireSequence(project, command.sequenceId);
      const id = nextId("track", allTrackIds(project));
      const track: Track = {
        id,
        name:
          command.name === undefined
            ? defaultTrackName(sequence, command.kind)
            : assertTrackName(command.name),
        kind: command.kind,
        muted: false,
        locked: false,
        clips: [],
      };
      sequence.tracks.push(track);
      return result(project, command, `Added ${track.name}`, [sequence.id, id], [id]);
    }

    case "track.update": {
      if (
        command.name === undefined &&
        command.muted === undefined &&
        command.locked === undefined
      ) {
        throw new CommandError("EMPTY_TRACK_UPDATE", "Track update must change at least one field");
      }
      const { track } = requireTrackLocation(project, command.trackId);
      if (command.name !== undefined) track.name = assertTrackName(command.name);
      if (command.muted !== undefined) track.muted = command.muted;
      if (command.locked !== undefined) track.locked = command.locked;
      return result(project, command, `Updated ${track.name}`, [track.id]);
    }

    case "track.remove": {
      const { sequence, track, trackIndex } = requireTrackLocation(project, command.trackId);
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      if (track.clips.length > 0) {
        throw new CommandError(
          "TRACK_NOT_EMPTY",
          `Track ${track.id} must be empty before it can be removed`,
        );
      }
      sequence.tracks.splice(trackIndex, 1);
      return result(project, command, `Removed ${track.name}`, [sequence.id, track.id]);
    }

    case "track.reorder": {
      if (!Number.isSafeInteger(command.index)) {
        throw new CommandError("INVALID_TRACK_INDEX", "Track index must be a safe integer");
      }
      const { sequence, track, trackIndex } = requireTrackLocation(project, command.trackId);
      if (command.index < 0 || command.index >= sequence.tracks.length) {
        throw new CommandError(
          "INVALID_TRACK_INDEX",
          `Track index must be between 0 and ${sequence.tracks.length - 1}`,
        );
      }
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      sequence.tracks.splice(trackIndex, 1);
      sequence.tracks.splice(command.index, 0, track);
      return result(project, command, `Moved ${track.name} to track ${command.index + 1}`, [
        sequence.id,
        track.id,
      ]);
    }

    case "clip.add": {
      assertTime(command.timelineStartUs, "timelineStartUs");
      const track = getTrack(project, command.trackId);
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      const asset = project.assets.find((candidate) => candidate.id === command.assetId);
      if (!asset) throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${command.assetId}`);
      assertAssetTrackCompatibility(asset, track);
      const sourceStartUs = command.sourceStartUs ?? 0;
      const sourceEndUs = command.sourceEndUs ?? asset.durationUs;
      assertTime(sourceStartUs, "sourceStartUs");
      assertTime(sourceEndUs, "sourceEndUs");
      if (sourceEndUs <= sourceStartUs || sourceEndUs > asset.durationUs) {
        throw new CommandError(
          "INVALID_SOURCE_RANGE",
          "Clip source range must be positive and inside the asset",
        );
      }
      const clip: Clip = {
        id: nextId("clip", allClipIds(project)),
        assetId: asset.id,
        timelineStartUs: command.timelineStartUs,
        sourceStartUs,
        sourceEndUs,
        transform: { ...DEFAULT_TRANSFORM, ...command.transform },
      };
      assertNoOverlap(track, clip);
      track.clips.push(clip);
      sortClips(track);
      return result(project, command, `Added ${clip.id}`, [track.id, clip.id], [clip.id]);
    }

    case "clip.remove": {
      const location = findClip(project, command.clipId);
      if (location.track.locked)
        throw new CommandError("TRACK_LOCKED", `Track is locked: ${location.track.id}`);
      location.track.clips.splice(location.clipIndex, 1);
      return result(project, command, `Removed ${command.clipId}`, [
        location.track.id,
        command.clipId,
      ]);
    }

    case "clip.move": {
      assertTime(command.timelineStartUs, "timelineStartUs");
      const location = findClip(project, command.clipId);
      const targetTrackId = command.trackId ?? location.track.id;
      const targetTrack = getTrack(project, targetTrackId);
      if (location.track.locked || targetTrack.locked) {
        throw new CommandError("TRACK_LOCKED", "Cannot move a clip from or to a locked track");
      }
      if (findSequenceForTrack(project, targetTrack.id) !== location.sequence.id) {
        throw new CommandError("SEQUENCE_MISMATCH", "V1 cannot move clips between sequences");
      }
      const asset = project.assets.find((candidate) => candidate.id === location.clip.assetId);
      if (!asset) {
        throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${location.clip.assetId}`);
      }
      assertAssetTrackCompatibility(asset, targetTrack);
      const moved = { ...location.clip, timelineStartUs: command.timelineStartUs };
      assertNoOverlap(targetTrack, moved, moved.id);
      location.track.clips.splice(location.clipIndex, 1);
      targetTrack.clips.push(moved);
      sortClips(location.track);
      if (targetTrack !== location.track) sortClips(targetTrack);
      return result(project, command, `Moved ${moved.id}`, [
        ...new Set([location.track.id, targetTrack.id]),
        moved.id,
      ]);
    }

    case "clip.trimStart": {
      assertTime(command.atUs, "atUs");
      const { clip, track } = findClip(project, command.clipId);
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      const end = clipEndUs(clip);
      if (command.atUs < clip.timelineStartUs || command.atUs >= end) {
        throw new CommandError("INVALID_TRIM", "Trim start must be within the clip");
      }
      const delta = command.atUs - clip.timelineStartUs;
      const trimmed = {
        ...clip,
        timelineStartUs: command.atUs,
        sourceStartUs: clip.sourceStartUs + delta,
      };
      assertNoOverlap(track, trimmed, clip.id);
      Object.assign(clip, trimmed);
      sortClips(track);
      return result(project, command, `Trimmed start of ${clip.id}`, [track.id, clip.id]);
    }

    case "clip.trimEnd": {
      assertTime(command.atUs, "atUs");
      const { clip, track } = findClip(project, command.clipId);
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      if (command.atUs <= clip.timelineStartUs || command.atUs > clipEndUs(clip)) {
        throw new CommandError("INVALID_TRIM", "Trim end must be within the clip");
      }
      const trimmed = {
        ...clip,
        sourceEndUs: clip.sourceStartUs + (command.atUs - clip.timelineStartUs),
      };
      assertNoOverlap(track, trimmed, clip.id);
      Object.assign(clip, trimmed);
      return result(project, command, `Trimmed end of ${clip.id}`, [track.id, clip.id]);
    }

    case "clip.split": {
      assertTime(command.atUs, "atUs");
      const { clip, track } = findClip(project, command.clipId);
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      if (!canSplitClipAt(clip, command.atUs)) {
        throw new CommandError("INVALID_SPLIT", "Split point must be strictly inside the clip");
      }
      const rightId = nextId("clip", allClipIds(project));
      const sourceSplitUs = clip.sourceStartUs + (command.atUs - clip.timelineStartUs);
      const right: Clip = {
        ...structuredClone(clip),
        id: rightId,
        timelineStartUs: command.atUs,
        sourceStartUs: sourceSplitUs,
      };
      clip.sourceEndUs = sourceSplitUs;
      track.clips.push(right);
      sortClips(track);
      return result(
        project,
        command,
        `Split ${clip.id} into ${clip.id} and ${right.id}`,
        [track.id, clip.id, right.id],
        [right.id],
      );
    }
  }
}

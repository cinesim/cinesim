import { nextId } from "../ids";
import type { AssetId, ClipId, SequenceId, TrackId } from "../ids";
import {
  canSplitClipAt,
  clipEndUs,
  DEFAULT_TRANSFORM,
  isAssetMediaCompatibleWithTrack,
} from "../project/types";
import type { Asset, AssetSource, Clip, Project, Sequence, Track } from "../project/types";
import {
  findClip,
  findSequenceForTrack,
  findTrack,
  getSequence,
  getTrack,
} from "../project/selectors";
import type { ClipLocation, TrackLocation } from "../project/selectors";
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

function allSequenceIds(project: Project): string[] {
  return project.sequences.map((sequence) => sequence.id);
}

function assertUniqueAssetIds(assetIds: readonly AssetId[]): void {
  if (assetIds.length === 0)
    throw new CommandError("EMPTY_ASSET_SELECTION", "Select at least one asset");
  if (new Set(assetIds).size !== assetIds.length)
    throw new CommandError("DUPLICATE_ASSET_ID", "Asset selection contains duplicate IDs");
}

function assertSourceAllowed(project: Project, source: AssetSource): void {
  if (!project.cloudProjectId && source.kind === "cloud")
    throw new CommandError(
      "LOCAL_PROJECT_CLOUD_SOURCE",
      "Cloud-backed media can only be used in a cloud project",
    );
}

function requireAssets(project: Project, assetIds: readonly AssetId[]): Asset[] {
  assertUniqueAssetIds(assetIds);
  return assetIds.map((assetId) => {
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${assetId}`);
    return asset;
  });
}

function assertSequenceName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new CommandError("INVALID_SEQUENCE_NAME", "Timeline name cannot be empty");
  return normalized;
}

function defaultSequenceName(project: Project): string {
  const pattern = /^Timeline (\d+)$/;
  const highestOrdinal = project.sequences.reduce((highest, sequence) => {
    const match = pattern.exec(sequence.name);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 1);
  return `Timeline ${highestOrdinal + 1}`;
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

function trackInsertionIndex(sequence: Sequence, kind: Track["kind"]): number {
  return kind === "audio" ? sequence.tracks.length : 0;
}

function assertAssetTrackCompatibility(
  asset: Asset,
  track: Track,
  mediaKind: Clip["mediaKind"],
): void {
  if (isAssetMediaCompatibleWithTrack(asset, mediaKind, track.kind)) return;
  const compatibleTracks = mediaKind === "audio" ? "audio" : "video or overlay";
  throw new CommandError(
    "INCOMPATIBLE_TRACK",
    `${mediaKind} component from ${asset.id} can only be placed on ${compatibleTracks} tracks`,
  );
}

function linkedLocation(project: Project, clip: Clip): ClipLocation | null {
  if (!clip.linkedClipId) return null;
  const linked = findClip(project, clip.linkedClipId);
  if (linked.clip.linkedClipId !== clip.id) {
    throw new CommandError("INVALID_CLIP_LINK", `Clip link is not reciprocal: ${clip.id}`);
  }
  return linked;
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
      assertSourceAllowed(project, command.asset.source);
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

    case "asset.setSource": {
      const asset = project.assets.find((candidate) => candidate.id === command.assetId);
      if (!asset) throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${command.assetId}`);
      assertSourceAllowed(project, command.source);
      asset.source = structuredClone(command.source);
      return result(project, command, `Updated source for ${asset.name}`, [asset.id]);
    }

    case "asset.remove": {
      const assets = requireAssets(project, command.assetIds);
      const selected = new Set(command.assetIds);
      const affected = project.sequences.flatMap((sequence) =>
        sequence.tracks.flatMap((track) => {
          const clips = track.clips.filter((clip) => selected.has(clip.assetId));
          if (clips.length > 0 && track.locked)
            throw new CommandError(
              "TRACK_LOCKED",
              `Asset is used on locked track ${track.id}: ${track.name}`,
            );
          return clips.length > 0 ? [{ sequence, track, clips }] : [];
        }),
      );
      for (const { track, clips } of affected) {
        const removed = new Set(clips.map((clip) => clip.id));
        track.clips = track.clips.filter((clip) => !removed.has(clip.id));
      }
      project.assets = project.assets.filter((asset) => !selected.has(asset.id));
      const clipIds = affected.flatMap(({ clips }) => clips.map((clip) => clip.id));
      const trackIds = affected.map(({ track }) => track.id);
      const sequenceIds = affected.map(({ sequence }) => sequence.id);
      return result(
        project,
        command,
        `Removed ${assets.length} ${assets.length === 1 ? "asset" : "assets"}`,
        [...new Set([...command.assetIds, ...sequenceIds, ...trackIds, ...clipIds])],
      );
    }

    case "sequence.createFromAssets": {
      const assets = requireAssets(project, command.assetIds);
      const template = requireSequence(project, project.activeSequenceId);
      const width = command.width ?? template.width;
      const height = command.height ?? template.height;
      const frameRate = command.frameRate ?? template.frameRate;
      if (!Number.isSafeInteger(width) || width <= 0)
        throw new CommandError(
          "INVALID_SEQUENCE_FORMAT",
          "Timeline width must be a positive integer",
        );
      if (!Number.isSafeInteger(height) || height <= 0)
        throw new CommandError(
          "INVALID_SEQUENCE_FORMAT",
          "Timeline height must be a positive integer",
        );
      if (!Number.isFinite(frameRate) || frameRate <= 0)
        throw new CommandError("INVALID_SEQUENCE_FORMAT", "Timeline frame rate must be positive");
      for (const asset of assets) {
        if (!Number.isSafeInteger(asset.durationUs) || asset.durationUs <= 0)
          throw new CommandError(
            "INVALID_SOURCE_RANGE",
            `Asset must have a positive duration: ${asset.id}`,
          );
      }

      const sequenceId = nextId("sequence", allSequenceIds(project));
      const existingTrackIds = allTrackIds(project);
      const videoTrackId = nextId("track", existingTrackIds);
      const audioTrackId = nextId("track", [...existingTrackIds, videoTrackId]);
      const videoTrack: Track = {
        id: videoTrackId,
        name: "Video 1",
        kind: "video",
        muted: false,
        locked: false,
        clips: [],
      };
      const audioTrack: Track = {
        id: audioTrackId,
        name: "Audio 1",
        kind: "audio",
        muted: false,
        locked: false,
        clips: [],
      };
      const existingClipIds = allClipIds(project);
      const createdClipIds: ClipId[] = [];
      let timelineStartUs = 0;
      for (const asset of assets) {
        const primaryTrack = asset.kind === "audio" ? audioTrack : videoTrack;
        const primaryId = nextId("clip", [...existingClipIds, ...createdClipIds]);
        const linkedAudioId =
          asset.kind === "video" && asset.hasAudio === true
            ? nextId("clip", [...existingClipIds, ...createdClipIds, primaryId])
            : null;
        primaryTrack.clips.push({
          id: primaryId,
          assetId: asset.id,
          mediaKind: asset.kind === "audio" ? "audio" : "video",
          ...(linkedAudioId ? { linkedClipId: linkedAudioId } : {}),
          timelineStartUs,
          sourceStartUs: 0,
          sourceEndUs: asset.durationUs,
          transform: { ...DEFAULT_TRANSFORM },
        });
        createdClipIds.push(primaryId);
        if (linkedAudioId) {
          audioTrack.clips.push({
            id: linkedAudioId,
            assetId: asset.id,
            mediaKind: "audio",
            linkedClipId: primaryId,
            timelineStartUs,
            sourceStartUs: 0,
            sourceEndUs: asset.durationUs,
            transform: { ...DEFAULT_TRANSFORM },
          });
          createdClipIds.push(linkedAudioId);
        }
        timelineStartUs += asset.durationUs;
      }
      const sequence: Sequence = {
        id: sequenceId,
        name:
          command.name === undefined
            ? defaultSequenceName(project)
            : assertSequenceName(command.name),
        width,
        height,
        frameRate,
        tracks: [videoTrack, audioTrack],
      };
      project.sequences.push(sequence);
      project.activeSequenceId = sequence.id;
      return result(
        project,
        command,
        `Created ${sequence.name} from ${assets.length} ${assets.length === 1 ? "asset" : "assets"}`,
        [project.id, sequence.id, videoTrack.id, audioTrack.id, ...createdClipIds],
        [sequence.id, videoTrack.id, audioTrack.id, ...createdClipIds],
      );
    }

    case "sequence.remove": {
      const sequenceIndex = project.sequences.findIndex(
        (sequence) => sequence.id === command.sequenceId,
      );
      const sequence = project.sequences[sequenceIndex];
      if (!sequence)
        throw new CommandError("SEQUENCE_NOT_FOUND", `Sequence not found: ${command.sequenceId}`);
      if (project.sequences.length === 1)
        throw new CommandError("LAST_SEQUENCE", "A project must contain at least one timeline");
      const locked = sequence.tracks.find((track) => track.locked);
      if (locked)
        throw new CommandError(
          "TRACK_LOCKED",
          `Unlock ${locked.name} before deleting this timeline`,
        );
      const removedIds = [
        sequence.id,
        ...sequence.tracks.flatMap((track) => [track.id, ...track.clips.map((clip) => clip.id)]),
      ];
      project.sequences.splice(sequenceIndex, 1);
      if (project.activeSequenceId === sequence.id)
        project.activeSequenceId = project.sequences.toSorted((left, right) =>
          left.id.localeCompare(right.id),
        )[0]!.id;
      return result(project, command, `Removed ${sequence.name}`, [project.id, ...removedIds]);
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
      sequence.tracks.splice(trackInsertionIndex(sequence, track.kind), 0, track);
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
      const primaryMediaKind = asset.kind === "audio" ? "audio" : "video";
      assertAssetTrackCompatibility(asset, track, primaryMediaKind);
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
      let createdAudioTrack = false;
      let audioTrack: Track | null = null;
      if (command.audioTrackId || (asset.kind === "video" && asset.hasAudio === true)) {
        if (asset.kind !== "video" || asset.hasAudio !== true) {
          throw new CommandError(
            "ASSET_HAS_NO_AUDIO",
            `Asset ${asset.id} cannot create a linked audio component`,
          );
        }
        const sequence = findTrack(project, track.id).sequence;
        audioTrack = command.audioTrackId
          ? getTrack(project, command.audioTrackId)
          : (sequence.tracks.find(
              (candidate) =>
                candidate.kind === "audio" &&
                !candidate.locked &&
                !candidate.clips.some(
                  (clip) =>
                    command.timelineStartUs < clipEndUs(clip) &&
                    command.timelineStartUs + (sourceEndUs - sourceStartUs) > clip.timelineStartUs,
                ),
            ) ?? null);
        if (!audioTrack) {
          audioTrack = {
            id: nextId("track", allTrackIds(project)),
            name: defaultTrackName(sequence, "audio"),
            kind: "audio",
            muted: false,
            locked: false,
            clips: [],
          };
          sequence.tracks.push(audioTrack);
          createdAudioTrack = true;
        }
        if (audioTrack.locked)
          throw new CommandError("TRACK_LOCKED", `Track is locked: ${audioTrack.id}`);
        if (
          findSequenceForTrack(project, audioTrack.id) !== findSequenceForTrack(project, track.id)
        )
          throw new CommandError("SEQUENCE_MISMATCH", "Linked clips must belong to one sequence");
        assertAssetTrackCompatibility(asset, track, "video");
        assertAssetTrackCompatibility(asset, audioTrack, "audio");
      }
      const existingIds = allClipIds(project);
      const clipId = nextId("clip", existingIds);
      const audioClipId = audioTrack ? nextId("clip", [...existingIds, clipId]) : null;
      const clip: Clip = {
        id: clipId,
        assetId: asset.id,
        mediaKind: primaryMediaKind,
        ...(audioClipId ? { linkedClipId: audioClipId } : {}),
        timelineStartUs: command.timelineStartUs,
        sourceStartUs,
        sourceEndUs,
        transform: { ...DEFAULT_TRANSFORM, ...command.transform },
      };
      assertNoOverlap(track, clip);
      const audioClip: Clip | null =
        audioTrack && audioClipId
          ? {
              id: audioClipId,
              assetId: asset.id,
              mediaKind: "audio",
              linkedClipId: clip.id,
              timelineStartUs: command.timelineStartUs,
              sourceStartUs,
              sourceEndUs,
              transform: { ...DEFAULT_TRANSFORM },
            }
          : null;
      if (audioTrack && audioClip) assertNoOverlap(audioTrack, audioClip);
      track.clips.push(clip);
      sortClips(track);
      if (audioTrack && audioClip) {
        audioTrack.clips.push(audioClip);
        sortClips(audioTrack);
        return result(
          project,
          command,
          `Added linked clips ${clip.id} and ${audioClip.id}`,
          [track.id, audioTrack.id, clip.id, audioClip.id],
          [...(createdAudioTrack ? [audioTrack.id] : []), clip.id, audioClip.id],
        );
      }
      return result(project, command, `Added ${clip.id}`, [track.id, clip.id], [clip.id]);
    }

    case "clip.remove": {
      const location = findClip(project, command.clipId);
      const linked = linkedLocation(project, location.clip);
      if (location.track.locked)
        throw new CommandError("TRACK_LOCKED", `Track is locked: ${location.track.id}`);
      if (linked?.track.locked)
        throw new CommandError("TRACK_LOCKED", `Track is locked: ${linked.track.id}`);
      location.track.clips.splice(location.clipIndex, 1);
      if (linked) linked.track.clips.splice(linked.clipIndex, 1);
      return result(project, command, `Removed ${command.clipId}`, [
        location.track.id,
        command.clipId,
        ...(linked ? [linked.track.id, linked.clip.id] : []),
      ]);
    }

    case "clip.move": {
      assertTime(command.timelineStartUs, "timelineStartUs");
      const location = findClip(project, command.clipId);
      const linked = linkedLocation(project, location.clip);
      const targetTrackId = command.trackId ?? location.track.id;
      const targetTrack = getTrack(project, targetTrackId);
      if (location.track.locked || targetTrack.locked || linked?.track.locked) {
        throw new CommandError("TRACK_LOCKED", "Cannot move a clip from or to a locked track");
      }
      if (findSequenceForTrack(project, targetTrack.id) !== location.sequence.id) {
        throw new CommandError("SEQUENCE_MISMATCH", "V1 cannot move clips between sequences");
      }
      const asset = project.assets.find((candidate) => candidate.id === location.clip.assetId);
      if (!asset) {
        throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${location.clip.assetId}`);
      }
      assertAssetTrackCompatibility(asset, targetTrack, location.clip.mediaKind);
      const moved = { ...location.clip, timelineStartUs: command.timelineStartUs };
      assertNoOverlap(targetTrack, moved, moved.id);
      const deltaUs = command.timelineStartUs - location.clip.timelineStartUs;
      const movedLinked = linked
        ? { ...linked.clip, timelineStartUs: linked.clip.timelineStartUs + deltaUs }
        : null;
      if (movedLinked) {
        assertTime(movedLinked.timelineStartUs, "linkedTimelineStartUs");
        assertNoOverlap(linked!.track, movedLinked, movedLinked.id);
      }
      location.track.clips.splice(location.clipIndex, 1);
      targetTrack.clips.push(moved);
      if (linked && movedLinked) Object.assign(linked.clip, movedLinked);
      sortClips(location.track);
      if (targetTrack !== location.track) sortClips(targetTrack);
      if (linked) sortClips(linked.track);
      return result(project, command, `Moved ${moved.id}`, [
        ...new Set([location.track.id, targetTrack.id]),
        moved.id,
        ...(linked ? [linked.track.id, linked.clip.id] : []),
      ]);
    }

    case "clip.trimStart": {
      assertTime(command.atUs, "atUs");
      const { clip, track } = findClip(project, command.clipId);
      const linked = linkedLocation(project, clip);
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      if (linked?.track.locked)
        throw new CommandError("TRACK_LOCKED", `Track is locked: ${linked.track.id}`);
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
      const linkedTrimmed = linked
        ? {
            ...linked.clip,
            timelineStartUs: command.atUs,
            sourceStartUs: linked.clip.sourceStartUs + delta,
          }
        : null;
      if (linkedTrimmed) assertNoOverlap(linked!.track, linkedTrimmed, linkedTrimmed.id);
      Object.assign(clip, trimmed);
      if (linked && linkedTrimmed) Object.assign(linked.clip, linkedTrimmed);
      sortClips(track);
      if (linked) sortClips(linked.track);
      return result(project, command, `Trimmed start of ${clip.id}`, [
        track.id,
        clip.id,
        ...(linked ? [linked.track.id, linked.clip.id] : []),
      ]);
    }

    case "clip.trimEnd": {
      assertTime(command.atUs, "atUs");
      const { clip, track } = findClip(project, command.clipId);
      const linked = linkedLocation(project, clip);
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      if (linked?.track.locked)
        throw new CommandError("TRACK_LOCKED", `Track is locked: ${linked.track.id}`);
      if (command.atUs <= clip.timelineStartUs || command.atUs > clipEndUs(clip)) {
        throw new CommandError("INVALID_TRIM", "Trim end must be within the clip");
      }
      const trimmed = {
        ...clip,
        sourceEndUs: clip.sourceStartUs + (command.atUs - clip.timelineStartUs),
      };
      assertNoOverlap(track, trimmed, clip.id);
      const linkedTrimmed = linked
        ? {
            ...linked.clip,
            sourceEndUs: linked.clip.sourceStartUs + (command.atUs - linked.clip.timelineStartUs),
          }
        : null;
      if (linkedTrimmed) assertNoOverlap(linked!.track, linkedTrimmed, linkedTrimmed.id);
      Object.assign(clip, trimmed);
      if (linked && linkedTrimmed) Object.assign(linked.clip, linkedTrimmed);
      return result(project, command, `Trimmed end of ${clip.id}`, [
        track.id,
        clip.id,
        ...(linked ? [linked.track.id, linked.clip.id] : []),
      ]);
    }

    case "clip.split": {
      assertTime(command.atUs, "atUs");
      const { clip, track } = findClip(project, command.clipId);
      const linked = linkedLocation(project, clip);
      if (track.locked) throw new CommandError("TRACK_LOCKED", `Track is locked: ${track.id}`);
      if (linked?.track.locked)
        throw new CommandError("TRACK_LOCKED", `Track is locked: ${linked.track.id}`);
      if (!canSplitClipAt(clip, command.atUs)) {
        throw new CommandError("INVALID_SPLIT", "Split point must be strictly inside the clip");
      }
      if (linked && !canSplitClipAt(linked.clip, command.atUs)) {
        throw new CommandError("INVALID_SPLIT", "Linked split point must be inside both clips");
      }
      const existingIds = allClipIds(project);
      const rightId = nextId("clip", existingIds);
      const linkedRightId = linked ? nextId("clip", [...existingIds, rightId]) : null;
      const sourceSplitUs = clip.sourceStartUs + (command.atUs - clip.timelineStartUs);
      const right: Clip = {
        ...structuredClone(clip),
        id: rightId,
        ...(linkedRightId ? { linkedClipId: linkedRightId } : {}),
        timelineStartUs: command.atUs,
        sourceStartUs: sourceSplitUs,
      };
      const linkedSourceSplitUs = linked
        ? linked.clip.sourceStartUs + (command.atUs - linked.clip.timelineStartUs)
        : null;
      const linkedRight: Clip | null =
        linked && linkedRightId && linkedSourceSplitUs !== null
          ? {
              ...structuredClone(linked.clip),
              id: linkedRightId,
              linkedClipId: right.id,
              timelineStartUs: command.atUs,
              sourceStartUs: linkedSourceSplitUs,
            }
          : null;
      clip.sourceEndUs = sourceSplitUs;
      if (linked && linkedSourceSplitUs !== null) linked.clip.sourceEndUs = linkedSourceSplitUs;
      track.clips.push(right);
      sortClips(track);
      if (linked && linkedRight) {
        linked.track.clips.push(linkedRight);
        sortClips(linked.track);
      }
      return result(
        project,
        command,
        linkedRight
          ? `Split linked clips ${clip.id} and ${linked!.clip.id}`
          : `Split ${clip.id} into ${clip.id} and ${right.id}`,
        [
          track.id,
          clip.id,
          right.id,
          ...(linked && linkedRight ? [linked.track.id, linked.clip.id, linkedRight.id] : []),
        ],
        [right.id, ...(linkedRight ? [linkedRight.id] : [])],
      );
    }
  }
}

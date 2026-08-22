import type { ClipId, SequenceId, TrackId } from "../ids";
import type { Clip, Project, Sequence, Track } from "./types";

export function getSequence(project: Project, sequenceId = project.activeSequenceId): Sequence {
  const sequence = project.sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) throw new Error(`Sequence not found: ${sequenceId}`);
  return sequence;
}

export function getTrack(project: Project, trackId: TrackId): Track {
  for (const sequence of project.sequences) {
    const track = sequence.tracks.find((candidate) => candidate.id === trackId);
    if (track) return track;
  }
  throw new Error(`Track not found: ${trackId}`);
}

export interface ClipLocation {
  sequence: Sequence;
  track: Track;
  clip: Clip;
  clipIndex: number;
}

export function findClip(project: Project, clipId: ClipId): ClipLocation {
  for (const sequence of project.sequences) {
    for (const track of sequence.tracks) {
      const clipIndex = track.clips.findIndex((candidate) => candidate.id === clipId);
      const clip = track.clips[clipIndex];
      if (clip) return { sequence, track, clip, clipIndex };
    }
  }
  throw new Error(`Clip not found: ${clipId}`);
}

export function findSequenceForTrack(project: Project, trackId: TrackId): SequenceId {
  const sequence = project.sequences.find((candidate) =>
    candidate.tracks.some((track) => track.id === trackId),
  );
  if (!sequence) throw new Error(`Track not found: ${trackId}`);
  return sequence.id;
}

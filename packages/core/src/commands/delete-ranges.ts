import { nextId } from "../ids";
import type { ClipId, TrackId } from "../ids";
import { clipEndUs } from "../project/types";
import type { Clip, Project, Sequence, TimeUs, Track } from "../project/types";
import { CommandError } from "./types";
import type { CommandResult, EditorCommand, TimelineRange } from "./types";

const MAX_RANGES = 500;

interface ClipSegment {
  startUs: TimeUs;
  endUs: TimeUs;
}

interface ClipOutput {
  original: Clip;
  clips: Clip[];
}

function assertRangeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommandError(
      "INVALID_TIME",
      `${label} must be a non-negative integer number of microseconds`,
    );
  }
}

/** Sorts and merges touching ranges so every adapter gets identical semantics. */
export function normalizeTimelineRanges(ranges: readonly TimelineRange[]): TimelineRange[] {
  if (ranges.length === 0) {
    throw new CommandError("EMPTY_RANGE_SELECTION", "Select at least one timeline range");
  }
  if (ranges.length > MAX_RANGES) {
    throw new CommandError("TOO_MANY_RANGES", `A range edit accepts at most ${MAX_RANGES} ranges`);
  }
  const sorted = ranges
    .map((range, index) => {
      assertRangeTime(range.startUs, `ranges[${index}].startUs`);
      assertRangeTime(range.endUs, `ranges[${index}].endUs`);
      if (range.endUs <= range.startUs) {
        throw new CommandError(
          "INVALID_RANGE",
          `ranges[${index}] must end strictly after it starts`,
        );
      }
      return { startUs: range.startUs, endUs: range.endUs };
    })
    .sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);

  const normalized: TimelineRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (!previous || range.startUs > previous.endUs) {
      normalized.push(range);
      continue;
    }
    previous.endUs = Math.max(previous.endUs, range.endUs);
  }
  return normalized;
}

function deletedBefore(timeUs: TimeUs, ranges: readonly TimelineRange[]): TimeUs {
  let durationUs = 0;
  for (const range of ranges) {
    if (range.startUs >= timeUs) break;
    durationUs += Math.max(0, Math.min(range.endUs, timeUs) - range.startUs);
  }
  return durationUs;
}

function remainingSegments(clip: Clip, ranges: readonly TimelineRange[]): ClipSegment[] {
  const startUs = clip.timelineStartUs;
  const endUs = clipEndUs(clip);
  const segments: ClipSegment[] = [];
  let cursorUs = startUs;

  for (const range of ranges) {
    if (range.endUs <= cursorUs) continue;
    if (range.startUs >= endUs) break;
    if (range.startUs > cursorUs) {
      segments.push({ startUs: cursorUs, endUs: Math.min(range.startUs, endUs) });
    }
    cursorUs = Math.max(cursorUs, range.endUs);
    if (cursorUs >= endUs) break;
  }
  if (cursorUs < endUs) segments.push({ startUs: cursorUs, endUs });
  return segments;
}

function trackIsAffected(
  track: Track,
  ranges: readonly TimelineRange[],
  mode: "lift" | "ripple",
): boolean {
  return track.clips.some((clip) => {
    const segments = remainingSegments(clip, ranges);
    if (segments.length !== 1) return true;
    const [segment] = segments;
    if (!segment) return true;
    if (segment.startUs !== clip.timelineStartUs || segment.endUs !== clipEndUs(clip)) return true;
    return mode === "ripple" && deletedBefore(clip.timelineStartUs, ranges) > 0;
  });
}

function clampFades(clip: Clip): void {
  const durationUs = clipEndUs(clip) - clip.timelineStartUs;
  const fadeInUs = Math.min(durationUs, clip.fadeInUs ?? 0);
  const fadeOutUs = Math.min(durationUs - fadeInUs, clip.fadeOutUs ?? 0);
  if (fadeInUs > 0) clip.fadeInUs = fadeInUs;
  else delete clip.fadeInUs;
  if (fadeOutUs > 0) clip.fadeOutUs = fadeOutUs;
  else delete clip.fadeOutUs;
}

function assertNoTrackOverlap(track: Track): void {
  for (let index = 1; index < track.clips.length; index += 1) {
    const previous = track.clips[index - 1];
    const current = track.clips[index];
    if (previous && current && clipEndUs(previous) > current.timelineStartUs) {
      throw new CommandError(
        "CLIP_OVERLAP",
        `${previous.id} overlaps ${current.id} on ${track.id}`,
      );
    }
  }
}

function sequenceClipMap(sequence: Sequence): Map<ClipId, { clip: Clip; track: Track }> {
  const clips = new Map<ClipId, { clip: Clip; track: Track }>();
  for (const track of sequence.tracks) {
    for (const clip of track.clips) clips.set(clip.id, { clip, track });
  }
  return clips;
}

function validateLinks(sequence: Sequence): void {
  const clips = sequenceClipMap(sequence);
  for (const { clip } of clips.values()) {
    if (!clip.linkedClipId) continue;
    const linked = clips.get(clip.linkedClipId)?.clip;
    if (!linked || linked.linkedClipId !== clip.id) {
      throw new CommandError("INVALID_CLIP_LINK", `Clip link is not reciprocal: ${clip.id}`);
    }
    if (
      linked.assetId !== clip.assetId ||
      linked.timelineStartUs !== clip.timelineStartUs ||
      clipEndUs(linked) !== clipEndUs(clip) ||
      linked.sourceStartUs !== clip.sourceStartUs ||
      linked.sourceEndUs !== clip.sourceEndUs
    ) {
      throw new CommandError(
        "INVALID_CLIP_LINK",
        `Linked clips do not share an edit range: ${clip.id}`,
      );
    }
  }
}

function createOutputs(
  clip: Clip,
  ranges: readonly TimelineRange[],
  mode: "lift" | "ripple",
  allocatedIds: string[],
): ClipOutput {
  const originalStartUs = clip.timelineStartUs;
  const originalEndUs = clipEndUs(clip);
  const clips = remainingSegments(clip, ranges).map((segment, index) => {
    const output = structuredClone(clip);
    if (index > 0) {
      output.id = nextId("clip", allocatedIds);
      allocatedIds.push(output.id);
    }
    output.timelineStartUs =
      mode === "ripple"
        ? segment.startUs - deletedBefore(segment.startUs, ranges)
        : segment.startUs;
    output.sourceStartUs = clip.sourceStartUs + (segment.startUs - originalStartUs);
    output.sourceEndUs = clip.sourceStartUs + (segment.endUs - originalStartUs);
    if (segment.startUs !== originalStartUs) delete output.fadeInUs;
    if (segment.endUs !== originalEndUs) delete output.fadeOutUs;
    clampFades(output);
    return output;
  });
  return { original: clip, clips };
}

function restoreOutputLinks(outputs: ReadonlyMap<ClipId, ClipOutput>): void {
  for (const output of outputs.values()) {
    const linkedId = output.original.linkedClipId;
    if (!linkedId || output.original.id.localeCompare(linkedId) > 0) continue;
    const linkedOutput = outputs.get(linkedId);
    if (!linkedOutput || linkedOutput.clips.length !== output.clips.length) {
      throw new CommandError(
        "INVALID_CLIP_LINK",
        `Linked clips produced different edit fragments: ${output.original.id}`,
      );
    }
    for (let index = 0; index < output.clips.length; index += 1) {
      const clip = output.clips[index];
      const linked = linkedOutput.clips[index];
      if (!clip || !linked || clip.timelineStartUs !== linked.timelineStartUs) {
        throw new CommandError(
          "INVALID_CLIP_LINK",
          `Linked clips produced misaligned fragments: ${output.original.id}`,
        );
      }
      clip.linkedClipId = linked.id;
      linked.linkedClipId = clip.id;
    }
  }
}

export function applySequenceDeleteRanges(
  project: Project,
  command: Extract<EditorCommand, { type: "sequence.deleteRanges" }>,
): CommandResult {
  const sequence = project.sequences.find((candidate) => candidate.id === command.sequenceId);
  if (!sequence) {
    throw new CommandError("SEQUENCE_NOT_FOUND", `Sequence not found: ${command.sequenceId}`);
  }
  const ranges = normalizeTimelineRanges(command.ranges);
  validateLinks(sequence);
  const affectedTracks = sequence.tracks.filter((track) =>
    trackIsAffected(track, ranges, command.mode),
  );
  const lockedTrack = affectedTracks.find((track) => track.locked);
  if (lockedTrack) {
    throw new CommandError(
      "TRACK_LOCKED",
      `Unlock ${lockedTrack.name} before editing the selected timeline range`,
    );
  }
  if (affectedTracks.length === 0) {
    throw new CommandError("EMPTY_RANGE_EDIT", "The selected timeline range contains no edit");
  }

  const allocatedIds = project.sequences.flatMap((candidate) =>
    candidate.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const outputs = new Map<ClipId, ClipOutput>();
  for (const track of affectedTracks) {
    for (const clip of track.clips) {
      outputs.set(clip.id, createOutputs(clip, ranges, command.mode, allocatedIds));
    }
  }
  restoreOutputLinks(outputs);

  const createdIds: ClipId[] = [];
  const changedClipIds: ClipId[] = [];
  for (const track of affectedTracks) {
    const nextClips: Clip[] = [];
    for (const clip of track.clips) {
      const output = outputs.get(clip.id);
      if (!output) {
        nextClips.push(clip);
        continue;
      }
      nextClips.push(...output.clips);
      const unchanged =
        output.clips.length === 1 &&
        output.clips[0]?.timelineStartUs === clip.timelineStartUs &&
        output.clips[0]?.sourceStartUs === clip.sourceStartUs &&
        output.clips[0]?.sourceEndUs === clip.sourceEndUs;
      if (!unchanged) changedClipIds.push(clip.id);
      for (const created of output.clips.slice(1)) createdIds.push(created.id);
    }
    track.clips = nextClips.sort((left, right) =>
      left.timelineStartUs === right.timelineStartUs
        ? left.id.localeCompare(right.id)
        : left.timelineStartUs - right.timelineStartUs,
    );
    assertNoTrackOverlap(track);
  }

  const durationUs = ranges.reduce((total, range) => total + range.endUs - range.startUs, 0);
  const changedIds = [
    sequence.id,
    ...affectedTracks.map((track) => track.id as TrackId),
    ...changedClipIds,
    ...createdIds,
  ];
  return {
    project,
    command,
    changedIds: [...new Set(changedIds)],
    createdIds,
    summary: `${command.mode === "ripple" ? "Ripple deleted" : "Lifted"} ${ranges.length} ${ranges.length === 1 ? "range" : "ranges"} (${durationUs}us)`,
  };
}

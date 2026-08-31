import { irTimeUs, type IrClip, type IrTrack, type SemanticPatch } from "@cinesim/ir";
import { allocateId, assertUnlocked, clipEnd, setClipRange } from "./command-helpers";
import { CommandError, type CommandContext, type TimelineRange } from "./command-types";
import { normalizeTimelineRanges } from "./timeline-ranges";

interface Segment {
  start: number;
  end: number;
}

interface RangeDeletionState {
  context: CommandContext;
  ranges: readonly TimelineRange[];
  mode: "lift" | "ripple";
  createdIds: string[];
  changedIds: string[];
  outputsByClip: Map<string, IrClip[]>;
}

function deletedBefore(time: number, ranges: readonly TimelineRange[]): number {
  return ranges.reduce(
    (total, range) =>
      total +
      (range.startUs >= time ? 0 : Math.max(0, Math.min(time, range.endUs) - range.startUs)),
    0,
  );
}

function remainingSegments(clip: IrClip, ranges: readonly TimelineRange[]): Segment[] {
  const end = clipEnd(clip);
  const segments: Segment[] = [];
  let cursor: number = clip.timelineStartUs;
  for (const range of ranges) {
    if (range.endUs <= cursor) continue;
    if (range.startUs >= end) break;
    if (range.startUs > cursor) segments.push({ start: cursor, end: Math.min(range.startUs, end) });
    cursor = Math.max(cursor, range.endUs);
  }
  if (cursor < end) segments.push({ start: cursor, end });
  return segments;
}

function isUnchanged(
  clip: IrClip,
  segments: readonly Segment[],
  state: RangeDeletionState,
): boolean {
  return (
    segments.length === 1 &&
    segments[0]!.start === clip.timelineStartUs &&
    segments[0]!.end === clipEnd(clip) &&
    (state.mode !== "ripple" || deletedBefore(clip.timelineStartUs, state.ranges) === 0)
  );
}

function fragmentValues(
  original: IrClip,
  segment: Segment,
  state: RangeDeletionState,
): {
  start: number;
  sourceStart: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
} {
  const start =
    state.mode === "ripple"
      ? segment.start - deletedBefore(segment.start, state.ranges)
      : segment.start;
  const duration = segment.end - segment.start;
  const fadeIn =
    segment.start === original.timelineStartUs ? Math.min(original.fades.inUs, duration) : 0;
  return {
    start,
    sourceStart:
      original.sourceStartUs +
      Math.round((segment.start - original.timelineStartUs) * original.playbackRate),
    duration,
    fadeIn,
    fadeOut:
      segment.end === clipEnd(original) ? Math.min(original.fades.outUs, duration - fadeIn) : 0,
  };
}

function createFragment(
  original: IrClip,
  segment: Segment,
  track: IrTrack,
  state: RangeDeletionState,
): { clip: IrClip; patch: SemanticPatch } {
  const clip = structuredClone(original);
  clip.id = allocateId(state.context, "clip", state.createdIds);
  state.createdIds.push(clip.id);
  const values = fragmentValues(original, segment, state);
  clip.timelineStartUs = irTimeUs(values.start);
  clip.sourceStartUs = irTimeUs(values.sourceStart);
  clip.durationUs = irTimeUs(values.duration);
  clip.fades.inUs = irTimeUs(values.fadeIn);
  clip.fades.outUs = irTimeUs(values.fadeOut);
  return {
    clip,
    patch: {
      type: "node.insert",
      parentId: track.id,
      node: { kind: "clip", clip },
      anchor: `after:${original.id}`,
    },
  };
}

function deleteWholeClip(clip: IrClip, track: IrTrack, state: RangeDeletionState): void {
  assertUnlocked(track);
  state.context.patches.push({ type: "node.remove", nodeId: clip.id });
  state.outputsByClip.set(clip.id, []);
  state.changedIds.push(clip.id, track.id);
}

function processClip(clip: IrClip, track: IrTrack, state: RangeDeletionState): IrClip[] {
  const original = structuredClone(clip);
  const segments = remainingSegments(clip, state.ranges);
  if (segments.length === 0) {
    deleteWholeClip(clip, track, state);
    return [];
  }
  const unchanged = isUnchanged(clip, segments, state);
  if (!unchanged) assertUnlocked(track);
  const outputs = [clip];
  setClipRange(clip, fragmentValues(original, segments[0]!, state), state.context.patches);
  const insertions = segments
    .slice(1)
    .map((segment) => createFragment(original, segment, track, state));
  outputs.push(...insertions.map((fragment) => fragment.clip));
  state.context.patches.push(...insertions.map((fragment) => fragment.patch).reverse());
  state.outputsByClip.set(original.id, outputs);
  if (!unchanged) state.changedIds.push(clip.id, track.id);
  return outputs;
}

function relinkFragments(
  originalLinks: ReadonlyMap<string, string | undefined>,
  outputsByClip: ReadonlyMap<string, IrClip[]>,
): void {
  for (const [clipId, outputs] of outputsByClip) {
    const linkedId = originalLinks.get(clipId);
    if (!linkedId || clipId.localeCompare(linkedId) > 0) continue;
    const linkedOutputs = outputsByClip.get(linkedId);
    if (!linkedOutputs || linkedOutputs.length !== outputs.length) {
      throw new CommandError(
        "INVALID_CLIP_LINK",
        `Linked clips produced different range fragments: ${clipId}`,
      );
    }
    outputs.forEach((output, index) => {
      const linked = linkedOutputs[index]!;
      output.linkedClipId = linked.id;
      linked.linkedClipId = output.id;
    });
  }
}

export function deleteTimelineRanges(
  context: CommandContext,
  compositionId: string,
  rangesInput: readonly TimelineRange[],
  mode: "lift" | "ripple",
): { changedIds: string[]; createdIds: string[] } {
  const composition = context.program.compositions.find(
    (candidate) => candidate.id === compositionId,
  );
  if (!composition) {
    throw new CommandError("SEQUENCE_NOT_FOUND", `Composition not found: ${compositionId}`);
  }
  const originalLinks = new Map(
    composition.timeline.tracks.flatMap((track) =>
      track.clips.map((clip) => [clip.id, clip.linkedClipId] as const),
    ),
  );
  const state: RangeDeletionState = {
    context,
    ranges: normalizeTimelineRanges(rangesInput),
    mode,
    createdIds: [],
    changedIds: [],
    outputsByClip: new Map(),
  };
  for (const track of composition.timeline.tracks) {
    track.clips = track.clips.flatMap((clip) => processClip(clip, track, state));
  }
  relinkFragments(originalLinks, state.outputsByClip);
  if (context.patches.length === 0) {
    throw new CommandError("EMPTY_RANGE_EDIT", "The selected timeline range contains no edit");
  }
  return {
    changedIds: [...state.changedIds, composition.id],
    createdIds: state.createdIds,
  };
}

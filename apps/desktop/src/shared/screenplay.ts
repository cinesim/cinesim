import { clipEndUs, timeUs, type Clip, type Project, type TimelineRange } from "@cinesim/core";
import type {
  VisualIndexAssetStatus,
  VisualIndexObservation,
  VisualIndexRange,
} from "@cinesim/project-io";

export interface ScreenplayVisualAsset {
  status: VisualIndexAssetStatus;
  observations: VisualIndexObservation[];
}

export type ScreenplayEntry =
  | {
      kind: "scene";
      id: string;
      timelineStartUs: number;
      timelineEndUs: number;
      title: string;
    }
  | {
      kind: "action";
      id: string;
      timelineStartUs: number;
      timelineEndUs: number;
      clipId: string;
      assetId: string;
      assetName: string;
      observation: VisualIndexObservation;
    }
  | {
      kind: "support";
      id: string;
      timelineStartUs: number;
      timelineEndUs: number;
      clipId: string;
      assetId: string;
      label: string;
      media: "picture" | "audio";
    }
  | {
      kind: "visual-coverage";
      id: string;
      timelineStartUs: number;
      timelineEndUs: number;
      clipId: string;
      assetId: string;
      assetName: string;
      state: "missing" | "stale" | "partial";
    };

function timelineRange(clip: Clip, source: VisualIndexRange): TimelineRange | null {
  const sourceStartUs = Math.max(clip.sourceStartUs, source.sourceInUs);
  const sourceEndUs = Math.min(clip.sourceEndUs, source.sourceOutUs);
  if (sourceEndUs <= sourceStartUs) return null;
  const playbackRate = clip.playbackRate ?? 1;
  return {
    startUs: timeUs(
      clip.timelineStartUs + Math.round((sourceStartUs - clip.sourceStartUs) / playbackRate),
    ),
    endUs: timeUs(
      clip.timelineStartUs + Math.round((sourceEndUs - clip.sourceStartUs) / playbackRate),
    ),
  };
}

function uncoveredSourceRanges(
  clip: Clip,
  covered: readonly VisualIndexRange[],
): VisualIndexRange[] {
  const intersections = covered
    .map((range) => ({
      sourceInUs: Math.max(clip.sourceStartUs, range.sourceInUs),
      sourceOutUs: Math.min(clip.sourceEndUs, range.sourceOutUs),
    }))
    .filter((range) => range.sourceOutUs > range.sourceInUs)
    .sort((left, right) => left.sourceInUs - right.sourceInUs);
  const gaps: VisualIndexRange[] = [];
  let cursor: number = clip.sourceStartUs;
  for (const range of intersections) {
    if (range.sourceInUs > cursor) gaps.push({ sourceInUs: cursor, sourceOutUs: range.sourceInUs });
    cursor = Math.max(cursor, range.sourceOutUs);
  }
  if (cursor < clip.sourceEndUs) gaps.push({ sourceInUs: cursor, sourceOutUs: clip.sourceEndUs });
  return gaps;
}

function actionEntries(
  clip: Clip,
  assetName: string,
  visual: ScreenplayVisualAsset | undefined,
): ScreenplayEntry[] {
  if (!visual || visual.status.state !== "current") return [];
  return visual.observations.flatMap((observation) => {
    const range = timelineRange(clip, observation);
    return range
      ? [
          {
            kind: "action" as const,
            id: `${clip.id}:${observation.id}`,
            timelineStartUs: range.startUs,
            timelineEndUs: range.endUs,
            clipId: clip.id,
            assetId: clip.assetId,
            assetName,
            observation,
          },
        ]
      : [];
  });
}

function coverageEntries(
  clip: Clip,
  assetName: string,
  visual: ScreenplayVisualAsset | undefined,
): ScreenplayEntry[] {
  const state = visual?.status.state ?? "missing";
  const gaps =
    state === "current"
      ? uncoveredSourceRanges(clip, visual?.status.coverage ?? [])
      : [{ sourceInUs: clip.sourceStartUs, sourceOutUs: clip.sourceEndUs }];
  return gaps.flatMap((gap, index) => {
    const range = timelineRange(clip, gap);
    return range
      ? [
          {
            kind: "visual-coverage" as const,
            id: `${clip.id}:visual-gap:${index}`,
            timelineStartUs: range.startUs,
            timelineEndUs: range.endUs,
            clipId: clip.id,
            assetId: clip.assetId,
            assetName,
            state: state === "current" ? ("partial" as const) : state,
          },
        ]
      : [];
  });
}

export function projectScreenplayEntries(
  project: Project,
  sequenceId: string,
  visuals: ReadonlyMap<string, ScreenplayVisualAsset>,
  markers: readonly { id: string; atUs: number; name: string }[] = [],
): ScreenplayEntry[] {
  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  if (!sequence) return [];
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const baseVisualTrackId = sequence.tracks.filter((track) => track.kind !== "audio").at(-1)?.id;
  const scenes: ScreenplayEntry[] = sequence.notes
    .filter((note) => note.kind === "scene")
    .map((note) => ({
      kind: "scene",
      id: note.id,
      timelineStartUs: note.atUs,
      timelineEndUs: note.atUs + (note.durationUs ?? timeUs(1)),
      title: note.text,
    }));
  scenes.push(
    ...markers.map((marker) => ({
      kind: "scene" as const,
      id: marker.id,
      timelineStartUs: marker.atUs,
      timelineEndUs: marker.atUs + 1,
      title: marker.name,
    })),
  );
  const clips = sequence.tracks.flatMap((track) =>
    track.clips.flatMap((clip) => {
      const asset = assets.get(clip.assetId);
      if (!asset) return [];
      const perception =
        clip.mediaKind === "video"
          ? [
              ...actionEntries(clip, asset.name, visuals.get(asset.id)),
              ...coverageEntries(clip, asset.name, visuals.get(asset.id)),
            ]
          : [];
      const support = supportEntry(clip, track.id, baseVisualTrackId, asset.kind, asset.name);
      return [...perception, ...(support ? [support] : [])];
    }),
  );
  return [...scenes, ...clips].sort(
    (left, right) =>
      left.timelineStartUs - right.timelineStartUs ||
      left.timelineEndUs - right.timelineEndUs ||
      left.id.localeCompare(right.id),
  );
}

function supportEntry(
  clip: Clip,
  trackId: string,
  baseVisualTrackId: string | undefined,
  assetKind: "video" | "audio" | "image",
  assetName: string,
): ScreenplayEntry | null {
  const supportingPicture = clip.mediaKind === "video" && trackId !== baseVisualTrackId;
  const supportingAudio = clip.mediaKind === "audio" && !clip.linkedClipId;
  if (!supportingPicture && !supportingAudio) return null;
  return {
    kind: "support",
    id: `${clip.id}:support`,
    timelineStartUs: clip.timelineStartUs,
    timelineEndUs: clipEndUs(clip),
    clipId: clip.id,
    assetId: clip.assetId,
    label: supportingPicture
      ? assetKind === "image"
        ? `Still · ${assetName}`
        : `Supporting picture · ${assetName}`
      : `Supporting audio · ${assetName}`,
    media: supportingPicture ? "picture" : "audio",
  };
}

export function splitVisualObservation(
  observation: VisualIndexObservation,
  existingIds: ReadonlySet<string>,
): [VisualIndexObservation, VisualIndexObservation] | null {
  if (observation.sourceOutUs - observation.sourceInUs < 2) return null;
  const midpoint = Math.floor((observation.sourceInUs + observation.sourceOutUs) / 2);
  const baseId = `${observation.id}_split_${midpoint}`;
  let secondId = baseId;
  let suffix = 2;
  while (existingIds.has(secondId)) secondId = `${baseId}_${suffix++}`;
  return [
    { ...observation, sourceOutUs: midpoint },
    { ...observation, id: secondId, sourceInUs: midpoint },
  ];
}

function combinedStrings(
  left?: readonly string[],
  right?: readonly string[],
): string[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length > 0 ? [...new Set(values)].sort() : undefined;
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

export function mergeVisualObservations(
  left: VisualIndexObservation,
  right: VisualIndexObservation,
): VisualIndexObservation {
  const people = combinedStrings(left.people, right.people);
  const tags = combinedStrings(left.tags, right.tags);
  const continuity = combinedStrings(
    left.continuity ? [left.continuity] : undefined,
    right.continuity ? [right.continuity] : undefined,
  )?.join(" ");
  const result: VisualIndexObservation = {
    ...left,
    sourceInUs: Math.min(left.sourceInUs, right.sourceInUs),
    sourceOutUs: Math.max(left.sourceOutUs, right.sourceOutUs),
    description: [left.description, right.description]
      .filter((value, index, values) => index === 0 || value !== values[0])
      .join(" "),
    provenance: "ui-merge",
  };
  if (people) result.people = people;
  if (tags) result.tags = tags;
  if (continuity) result.continuity = continuity;
  const confidence = minimumDefined(left.confidence, right.confidence);
  if (confidence !== undefined) result.confidence = confidence;
  return result;
}

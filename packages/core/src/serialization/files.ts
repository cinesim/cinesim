import { z } from "zod";
import { nextId } from "../ids";
import { clipEndUs, DEFAULT_TRANSFORM, isAssetMediaCompatibleWithTrack } from "../project/types";
import type { Asset, Clip, Project, ProjectSettings, Sequence, Track } from "../project/types";
import { assetSchema, clipSchema, sequenceSchema, settingsSchema, trackSchema } from "./schema";

export const PROJECT_FILES = {
  manifest: "cinesim.json",
  assets: ".cinesim/assets.json",
  timeline: ".cinesim/timeline.json",
  settings: ".cinesim/settings.toml",
} as const;

const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^project_/),
  name: z.string().min(1),
  activeSequenceId: z.string().regex(/^sequence_/),
  files: z.object({
    assets: z.literal(PROJECT_FILES.assets),
    timeline: z.literal(PROJECT_FILES.timeline),
    settings: z.literal(PROJECT_FILES.settings),
  }),
});

const assetsFileSchema = z.object({ version: z.literal(1), assets: z.array(assetSchema) });
const inputClipSchema = clipSchema.extend({ mediaKind: z.enum(["video", "audio"]).optional() });
const inputTrackSchema = trackSchema.extend({ clips: z.array(inputClipSchema) });
const inputSequenceSchema = sequenceSchema.extend({ tracks: z.array(inputTrackSchema) });
const timelineFileSchema = z.object({
  version: z.literal(1),
  sequences: z.array(inputSequenceSchema),
});

type InputClip = Omit<Clip, "mediaKind"> & { mediaKind?: Clip["mediaKind"] };
type InputTrack = Omit<Track, "clips"> & { clips: InputClip[] };
type InputSequence = Omit<Sequence, "tracks"> & { tracks: InputTrack[] };

function migrateExplicitMediaComponents(
  sequences: InputSequence[],
  assets: readonly Asset[],
): InputSequence[] {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const clipIds = sequences.flatMap((sequence) =>
    sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const trackIds = sequences.flatMap((sequence) => sequence.tracks.map((track) => track.id));
  for (const sequence of sequences) {
    const implicitComponents = sequence.tracks.flatMap((track) =>
      track.clips.filter((clip) => clip.mediaKind === undefined).map((clip) => ({ clip, track })),
    );
    for (const { clip, track } of implicitComponents) {
      const asset = assetsById.get(clip.assetId);
      if (!asset) continue;
      clip.mediaKind = track.kind === "audio" || asset.kind === "audio" ? "audio" : "video";
      if (
        clip.linkedClipId ||
        clip.mediaKind !== "video" ||
        asset.kind !== "video" ||
        asset.hasAudio !== true
      )
        continue;
      let audioTrack = sequence.tracks.find(
        (candidate) =>
          candidate.kind === "audio" &&
          !candidate.locked &&
          !candidate.clips.some(
            (candidateClip) =>
              clip.timelineStartUs < clipEndUs(candidateClip as Clip) &&
              clipEndUs(clip as Clip) > candidateClip.timelineStartUs,
          ),
      );
      if (!audioTrack) {
        const audioOrdinal =
          sequence.tracks.reduce((highest, candidate) => {
            const match = /^Audio (\d+)$/.exec(candidate.name);
            return match ? Math.max(highest, Number(match[1])) : highest;
          }, 0) + 1;
        const trackId = nextId("track", trackIds);
        trackIds.push(trackId);
        audioTrack = {
          id: trackId,
          name: `Audio ${audioOrdinal}`,
          kind: "audio",
          muted: false,
          locked: false,
          clips: [],
        };
        sequence.tracks.push(audioTrack);
      }
      const audioClipId = nextId("clip", clipIds);
      clipIds.push(audioClipId);
      clip.linkedClipId = audioClipId;
      audioTrack.clips.push({
        id: audioClipId,
        assetId: clip.assetId,
        mediaKind: "audio",
        linkedClipId: clip.id,
        timelineStartUs: clip.timelineStartUs,
        sourceStartUs: clip.sourceStartUs,
        sourceEndUs: clip.sourceEndUs,
        transform: { ...DEFAULT_TRANSFORM },
      });
    }
  }
  return sequences;
}

export interface ProjectManifest {
  version: 1;
  id: Project["id"];
  name: string;
  activeSequenceId: Project["activeSequenceId"];
  files: {
    assets: typeof PROJECT_FILES.assets;
    timeline: typeof PROJECT_FILES.timeline;
    settings: typeof PROJECT_FILES.settings;
  };
}

export interface AssetsFile {
  version: 1;
  assets: Asset[];
}

export interface TimelineFile {
  version: 1;
  sequences: Sequence[];
}

export function splitProjectFiles(project: Project): {
  manifest: ProjectManifest;
  assets: AssetsFile;
  timeline: TimelineFile;
} {
  const canonical = canonicalizeProject(project);
  return {
    manifest: {
      version: 1,
      id: canonical.id,
      name: canonical.name,
      activeSequenceId: canonical.activeSequenceId,
      files: {
        assets: PROJECT_FILES.assets,
        timeline: PROJECT_FILES.timeline,
        settings: PROJECT_FILES.settings,
      },
    },
    assets: { version: 1, assets: canonical.assets },
    timeline: { version: 1, sequences: canonical.sequences },
  };
}

export function joinProjectFiles(
  manifestInput: unknown,
  assetsInput: unknown,
  timelineInput: unknown,
): Project {
  const manifest = manifestSchema.parse(manifestInput);
  const assets = assetsFileSchema.parse(assetsInput);
  const timelineInputFile = timelineFileSchema.parse(timelineInput);
  const timeline: TimelineFile = {
    version: 1,
    sequences: z
      .array(sequenceSchema)
      .parse(
        migrateExplicitMediaComponents(
          timelineInputFile.sequences as InputSequence[],
          assets.assets as Asset[],
        ),
      ) as Sequence[],
  };
  if (!timeline.sequences.some((sequence) => sequence.id === manifest.activeSequenceId)) {
    throw new Error(`Active sequence not found: ${manifest.activeSequenceId}`);
  }
  const assetsById = new Map(assets.assets.map((asset) => [asset.id, asset]));
  for (const sequence of timeline.sequences) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const asset = assetsById.get(clip.assetId);
        if (!asset) throw new Error(`Clip ${clip.id} references missing asset ${clip.assetId}`);
        const compatible = isAssetMediaCompatibleWithTrack(
          asset as Asset,
          clip.mediaKind,
          track.kind,
        );
        if (!compatible) {
          throw new Error(
            `Clip ${clip.id} has incompatible ${asset.kind} media on ${track.kind} track ${track.id}`,
          );
        }
        if (clip.sourceEndUs <= clip.sourceStartUs)
          throw new Error(`Clip ${clip.id} has an invalid source range`);
      }
    }
  }
  const clipsById = new Map(
    timeline.sequences.flatMap((sequence) =>
      sequence.tracks.flatMap((track) =>
        track.clips.map((clip) => [clip.id, { clip, sequenceId: sequence.id }] as const),
      ),
    ),
  );
  for (const { clip, sequenceId } of clipsById.values()) {
    if (!clip.linkedClipId) continue;
    const linkedLocation = clipsById.get(clip.linkedClipId);
    const linked = linkedLocation?.clip;
    if (!linked || linked.linkedClipId !== clip.id || linkedLocation.sequenceId !== sequenceId)
      throw new Error(`Clip ${clip.id} has a missing or non-reciprocal link`);
    if (
      linked.assetId !== clip.assetId ||
      linked.timelineStartUs !== clip.timelineStartUs ||
      linked.sourceStartUs !== clip.sourceStartUs ||
      linked.sourceEndUs !== clip.sourceEndUs ||
      linked.mediaKind === clip.mediaKind
    )
      throw new Error(`Clip ${clip.id} has an invalid linked component`);
  }
  return canonicalizeProject({
    version: 1,
    id: manifest.id as Project["id"],
    name: manifest.name,
    activeSequenceId: manifest.activeSequenceId as Project["activeSequenceId"],
    assets: assets.assets as Asset[],
    sequences: timeline.sequences as Sequence[],
  });
}

export function parseSettings(input: unknown): ProjectSettings {
  return settingsSchema.parse(input) as ProjectSettings;
}

export function canonicalizeProject(project: Project): Project {
  const copy = structuredClone(project);
  copy.assets.sort((left, right) => left.id.localeCompare(right.id));
  copy.sequences.sort((left, right) => left.id.localeCompare(right.id));
  for (const sequence of copy.sequences) {
    // Track order is authored state: for visual tracks it also determines layer order.
    // Preserve it while canonicalizing the unordered collections around it.
    for (const track of sequence.tracks) {
      track.clips.sort((left, right) =>
        left.timelineStartUs === right.timelineStartUs
          ? left.id.localeCompare(right.id)
          : left.timelineStartUs - right.timelineStartUs,
      );
    }
  }
  return copy;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

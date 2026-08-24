import { z } from "zod";
import { isAssetCompatibleWithTrack, isAssetMediaCompatibleWithTrack } from "../project/types";
import type { Asset, Project, ProjectSettings, Sequence } from "../project/types";
import { assetSchema, sequenceSchema, settingsSchema } from "./schema";

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
const timelineFileSchema = z.object({ version: z.literal(1), sequences: z.array(sequenceSchema) });

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
  const timeline = timelineFileSchema.parse(timelineInput);
  if (!timeline.sequences.some((sequence) => sequence.id === manifest.activeSequenceId)) {
    throw new Error(`Active sequence not found: ${manifest.activeSequenceId}`);
  }
  const assetsById = new Map(assets.assets.map((asset) => [asset.id, asset]));
  for (const sequence of timeline.sequences) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const asset = assetsById.get(clip.assetId);
        if (!asset) throw new Error(`Clip ${clip.id} references missing asset ${clip.assetId}`);
        const compatible = clip.mediaKind
          ? isAssetMediaCompatibleWithTrack(asset as Asset, clip.mediaKind, track.kind)
          : isAssetCompatibleWithTrack(asset.kind, track.kind);
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
      sequence.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)),
    ),
  );
  for (const clip of clipsById.values()) {
    if (!clip.linkedClipId) continue;
    const linked = clipsById.get(clip.linkedClipId);
    if (!linked || linked.linkedClipId !== clip.id)
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

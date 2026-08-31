import { irTimeUs, serializeIr, validateIrProgram } from "@cinesim/ir";
import type { IrClip, IrProgram, IrTransform } from "@cinesim/ir";
import type {
  Asset,
  Clip,
  Project,
  ProjectSettings,
  Sequence,
  Track,
  Transform,
} from "../project/types";
import { timeUs } from "../project/types";

function transformToIr(transform: Transform): IrTransform {
  return {
    x: transform.x,
    y: transform.y,
    anchorX: 50,
    anchorY: 50,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotation: 0,
    opacity: transform.opacity,
    zIndex: 0,
    fit: transform.fit,
    cornerRadius: 0,
    blendMode: "normal",
  };
}

function clipToIr(clip: Clip, trackId: string): IrClip {
  return {
    id: clip.id,
    trackId,
    assetId: clip.assetId,
    mediaKind: clip.mediaKind,
    ...(clip.linkedClipId === undefined ? {} : { linkedClipId: clip.linkedClipId }),
    timelineStartUs: irTimeUs(clip.timelineStartUs),
    sourceStartUs: irTimeUs(clip.sourceStartUs),
    durationUs: irTimeUs(clip.sourceEndUs - clip.sourceStartUs),
    playbackRate: 1,
    enabled: true,
    reverse: false,
    freeze: false,
    loop: false,
    fades: { inUs: irTimeUs(clip.fadeInUs ?? 0), outUs: irTimeUs(clip.fadeOutUs ?? 0) },
    transform: transformToIr(clip.transform),
    audio: { gainDb: 0, pan: 0, muted: false },
    effects: [],
  };
}

/** Pure migration/comparison boundary. Format-v1 JSON must not be edited after conversion. */
export function v1ProjectToIr(project: Project, settings: ProjectSettings): IrProgram {
  const referencedAssetIds = [
    ...new Set(
      project.sequences.flatMap((sequence) =>
        sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const program: IrProgram = {
    version: 2,
    languageVersion: 1,
    projectId: project.id,
    activeCompositionId: project.activeSequenceId,
    referencedAssetIds,
    compositions: project.sequences.map((sequence) => ({
      id: sequence.id,
      name: sequence.name,
      width: sequence.width,
      height: sequence.height,
      frameRate: sequence.frameRate,
      background: settings.backgroundColor,
      timeline: {
        id: `timeline_${sequence.id.replace(/^sequence_/u, "")}`,
        markers: [],
        transitions: [],
        tracks: sequence.tracks.map((track) => ({
          id: track.id,
          kind: track.kind,
          name: track.name,
          muted: track.muted,
          locked: track.locked,
          clips: track.clips.map((clip) => clipToIr(clip, track.id)),
          effects: [],
        })),
      },
    })),
  };
  validateIrProgram(program, new Set(project.assets.map((asset) => asset.id)));
  return program;
}

function transformFromIr(transform: IrTransform): Transform {
  return {
    x: transform.x,
    y: transform.y,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    opacity: transform.opacity,
    fit: transform.fit,
  };
}

function clipFromIr(clip: IrClip): Clip {
  if (
    clip.assetId === undefined ||
    clip.mediaKind === undefined ||
    clip.playbackRate !== 1 ||
    clip.reverse ||
    clip.freeze ||
    clip.loop
  ) {
    throw new Error(`Clip ${clip.id} is not representable by the format-v1 comparison model.`);
  }
  return {
    id: clip.id as Clip["id"],
    assetId: clip.assetId as Clip["assetId"],
    mediaKind: clip.mediaKind,
    ...(clip.linkedClipId === undefined ? {} : { linkedClipId: clip.linkedClipId as Clip["id"] }),
    timelineStartUs: timeUs(clip.timelineStartUs),
    sourceStartUs: timeUs(clip.sourceStartUs),
    sourceEndUs: timeUs(clip.sourceStartUs + clip.durationUs),
    ...(clip.fades.inUs === 0 ? {} : { fadeInUs: timeUs(clip.fades.inUs) }),
    ...(clip.fades.outUs === 0 ? {} : { fadeOutUs: timeUs(clip.fades.outUs) }),
    transform: transformFromIr(clip.transform),
  };
}

export interface V1ComparisonContext {
  name: string;
  assets: Asset[];
  cloudProjectId?: Project["cloudProjectId"];
}

/** Used only by semantic equivalence and legacy-command parity tests. */
export function irToV1Project(program: IrProgram, context: V1ComparisonContext): Project {
  return {
    version: 1,
    id: program.projectId as Project["id"],
    ...(context.cloudProjectId === undefined ? {} : { cloudProjectId: context.cloudProjectId }),
    name: context.name,
    activeSequenceId: program.activeCompositionId as Project["activeSequenceId"],
    assets: structuredClone(context.assets),
    sequences: program.compositions.map((composition): Sequence => ({
      id: composition.id as Sequence["id"],
      name: composition.name,
      width: composition.width,
      height: composition.height,
      frameRate: composition.frameRate,
      tracks: composition.timeline.tracks.map((track): Track => ({
        id: track.id as Track["id"],
        kind: track.kind,
        name: track.name,
        muted: track.muted,
        locked: track.locked,
        clips: track.clips.map(clipFromIr),
      })),
    })),
  };
}

/**
 * Derived compatibility view for media subsystems that still accept the v1 object shape. Generated
 * scene clips are omitted because v1 cannot represent them. This value is never persisted or used
 * as edit authority.
 */
export function irProgramToProjectProjection(
  program: IrProgram,
  context: V1ComparisonContext,
): Project {
  return {
    version: 1,
    id: program.projectId as Project["id"],
    ...(context.cloudProjectId === undefined ? {} : { cloudProjectId: context.cloudProjectId }),
    name: context.name,
    activeSequenceId: program.activeCompositionId as Project["activeSequenceId"],
    assets: structuredClone(context.assets),
    sequences: program.compositions.map((composition): Sequence => ({
      id: composition.id as Sequence["id"],
      name: composition.name,
      width: composition.width,
      height: composition.height,
      frameRate: composition.frameRate,
      tracks: composition.timeline.tracks.map((track): Track => ({
        id: track.id as Track["id"],
        kind: track.kind,
        name: track.name,
        muted: track.muted,
        locked: track.locked,
        clips: track.clips.flatMap((clip) =>
          clip.assetId !== undefined && clip.mediaKind !== undefined ? [clipFromIr(clip)] : [],
        ),
      })),
    })),
  };
}

export function assertV1IrEquivalent(
  project: Project,
  settings: ProjectSettings,
  program: IrProgram,
): void {
  const expected = v1ProjectToIr(project, settings);
  if (serializeIr(expected) !== serializeIr(program))
    throw new Error("Format-v1 and format-v2 semantic timelines are not equivalent.");
}

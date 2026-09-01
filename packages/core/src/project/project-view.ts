import type { IrClip, IrProgram, IrTransform } from "@cinesim/ir";
import type { Asset, Clip, EditorialNote, Project, Sequence, Track, Transform } from "./types";
import { timeUs } from "./types";

function transformFromIr(transform: IrTransform): Transform {
  return {
    x: transform.x,
    y: transform.y,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotation: transform.rotation,
    opacity: transform.opacity,
    fit: transform.fit,
  };
}

function clipFromIr(clip: IrClip): Clip {
  if (clip.assetId === undefined || clip.mediaKind === undefined) {
    throw new Error(`Clip ${clip.id} is not media-backed and cannot enter the project view.`);
  }
  return {
    id: clip.id as Clip["id"],
    assetId: clip.assetId as Clip["assetId"],
    mediaKind: clip.mediaKind,
    ...(clip.linkedClipId === undefined ? {} : { linkedClipId: clip.linkedClipId as Clip["id"] }),
    timelineStartUs: timeUs(clip.timelineStartUs),
    durationUs: timeUs(clip.durationUs),
    sourceStartUs: timeUs(clip.sourceStartUs),
    sourceEndUs: timeUs(clip.sourceStartUs + Math.round(clip.durationUs * clip.playbackRate)),
    playbackRate: clip.playbackRate,
    ...(clip.fades.inUs === 0 ? {} : { fadeInUs: timeUs(clip.fades.inUs) }),
    ...(clip.fades.outUs === 0 ? {} : { fadeOutUs: timeUs(clip.fades.outUs) }),
    transform: transformFromIr(clip.transform),
  };
}

export interface ProjectViewContext {
  name: string;
  assets: readonly Asset[];
  notes?: readonly EditorialNote[];
  cloudProjectId?: Project["cloudProjectId"];
}

/** Builds the derived media/UI view. Canonical edit authority remains the supplied IR. */
export function projectViewFromIr(program: IrProgram, context: ProjectViewContext): Project {
  return {
    id: program.projectId as Project["id"],
    ...(context.cloudProjectId === undefined ? {} : { cloudProjectId: context.cloudProjectId }),
    name: context.name,
    activeSequenceId: program.activeCompositionId as Project["activeSequenceId"],
    assets: structuredClone([...context.assets]),
    notes: structuredClone([...(context.notes ?? [])]),
    sequences: program.compositions.map((composition): Sequence => ({
      id: composition.id as Sequence["id"],
      name: composition.name,
      width: composition.width,
      height: composition.height,
      frameRate: composition.frameRate,
      notes: composition.timeline.notes.map((note) => ({
        id: note.id,
        kind: note.kind,
        text: note.text,
        atUs: timeUs(note.atUs),
        ...(note.durationUs === undefined ? {} : { durationUs: timeUs(note.durationUs) }),
      })),
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

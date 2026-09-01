import {
  irTimeUs,
  validateIrProgram,
  type IrClip,
  type IrProgram,
  type IrTransform,
} from "@cinesim/ir";
import { nextId } from "../src/ids";
import type { ProjectId } from "../src/ids";
import { projectViewFromIr } from "../src/project/project-view";
import type {
  Asset,
  Clip,
  CloudProjectId,
  Project,
  ProjectSettings,
  Transform,
} from "../src/project/types";
import { DEFAULT_SETTINGS } from "../src/project/settings";
import { planSemanticCommand } from "../src/semantic/commands";
import type { SemanticCommandPlan, SemanticEditorCommand } from "../src/semantic/command-types";

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
  fit: "contain",
};

export interface CreateProjectOptions {
  id?: ProjectId;
  cloudProjectId?: CloudProjectId;
  name: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export function createProject(options: CreateProjectOptions): Project {
  const projectId = nextId("project", []);
  const sequenceId = nextId("sequence", []);
  const videoTrackId = nextId("track", []);
  const audioTrackId = nextId("track", [videoTrackId]);
  return {
    id: options.id ?? projectId,
    ...(options.cloudProjectId ? { cloudProjectId: options.cloudProjectId } : {}),
    name: options.name.trim() || "Untitled project",
    activeSequenceId: sequenceId,
    assets: [],
    notes: [],
    sequences: [
      {
        id: sequenceId,
        name: "Main timeline",
        width: options.width ?? 1920,
        height: options.height ?? 1080,
        frameRate: options.frameRate ?? 30,
        notes: [],
        tracks: [
          {
            id: videoTrackId,
            name: "Video 1",
            kind: "video",
            muted: false,
            locked: false,
            clips: [],
          },
          {
            id: audioTrackId,
            name: "Audio 1",
            kind: "audio",
            muted: false,
            locked: false,
            clips: [],
          },
        ],
      },
    ],
  };
}

function transformToIr(transform: Transform): IrTransform {
  return {
    x: transform.x,
    y: transform.y,
    anchorX: 50,
    anchorY: 50,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotation: transform.rotation,
    opacity: transform.opacity,
    zIndex: 0,
    fit: transform.fit,
    cornerRadius: 0,
    blendMode: "normal",
  };
}

function clipToIr(clip: Clip, trackId: string): IrClip {
  const playbackRate = clip.playbackRate ?? 1;
  const durationUs =
    clip.durationUs ?? Math.round((clip.sourceEndUs - clip.sourceStartUs) / playbackRate);
  return {
    id: clip.id,
    trackId,
    assetId: clip.assetId,
    mediaKind: clip.mediaKind,
    ...(clip.linkedClipId === undefined ? {} : { linkedClipId: clip.linkedClipId }),
    timelineStartUs: irTimeUs(clip.timelineStartUs),
    sourceStartUs: irTimeUs(clip.sourceStartUs),
    durationUs: irTimeUs(durationUs),
    playbackRate,
    enabled: true,
    reverse: false,
    freeze: false,
    loop: false,
    fades: { inUs: irTimeUs(clip.fadeInUs ?? 0), outUs: irTimeUs(clip.fadeOutUs ?? 0) },
    transform: transformToIr(clip.transform),
    audio: { gainDb: clip.gainDb ?? 0, pan: clip.pan ?? 0, muted: clip.muted ?? false },
    effects: [],
  };
}

export function projectToIr(
  project: Project,
  settings: ProjectSettings = DEFAULT_SETTINGS,
): IrProgram {
  const program: IrProgram = {
    version: 2,
    languageVersion: 1,
    projectId: project.id,
    activeCompositionId: project.activeSequenceId,
    referencedAssetIds: [
      ...new Set(
        project.sequences.flatMap((sequence) =>
          sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right)),
    compositions: project.sequences.map((sequence) => ({
      id: sequence.id,
      name: sequence.name,
      width: sequence.width,
      height: sequence.height,
      frameRate: sequence.frameRate,
      background: settings.backgroundColor,
      timeline: {
        id: `timeline_${sequence.id.replace(/^sequence_/u, "")}`,
        captionTracks: [],
        notes: sequence.notes.map(({ atUs, durationUs, ...note }) => ({
          ...note,
          atUs: irTimeUs(atUs),
          ...(durationUs === undefined ? {} : { durationUs: irTimeUs(durationUs) }),
        })),
        markers: [],
        transitions: [],
        audioTransitions: [],
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

function updatedAssets(assets: readonly Asset[], command: SemanticEditorCommand): Asset[] {
  if (command.type === "asset.import") return [...assets, command.asset];
  if (command.type === "asset.remove") {
    const removed = new Set(command.assetIds);
    return assets.filter((asset) => !removed.has(asset.id));
  }
  if (command.type === "asset.setSource") {
    return assets.map((asset) =>
      asset.id === command.assetId ? { ...asset, source: command.source } : asset,
    );
  }
  return [...assets];
}

export interface TestCommandResult extends SemanticCommandPlan {
  project: Project;
}

/** Test-only adapter that exercises the canonical semantic planner against a derived project view. */
export function applyCommand(project: Project, command: SemanticEditorCommand): TestCommandResult {
  const plan = planSemanticCommand(projectToIr(project), project.assets, command);
  const assets = updatedAssets(project.assets, command);
  return {
    ...plan,
    project: projectViewFromIr(plan.program, {
      name: project.name,
      assets,
      ...(project.cloudProjectId === undefined ? {} : { cloudProjectId: project.cloudProjectId }),
    }),
  };
}

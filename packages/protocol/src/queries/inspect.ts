import type { AssetId, Project } from "@cinesim/core";
import { projectTimeline, type IrEditMap, type IrProgram } from "@cinesim/ir";

export function inspectProject(
  program: IrProgram,
  project: Pick<Project, "name" | "assets" | "notes">,
) {
  const timeline = projectTimeline(program);
  return {
    version: program.version,
    id: program.projectId,
    name: project.name,
    activeCompositionId: program.activeCompositionId,
    durationUs: timeline.durationUs,
    assetCount: project.assets.length,
    projectNoteCount: project.notes.length,
    compositionCount: program.compositions.length,
    trackCount: timeline.tracks.length,
    clipCount: timeline.tracks.reduce((count, track) => count + track.clips.length, 0),
  };
}

export function inspectTimeline(program: IrProgram, editMap?: IrEditMap) {
  const timeline = projectTimeline(program, editMap);
  return {
    composition: {
      id: timeline.compositionId,
      name: timeline.name,
      width: timeline.width,
      height: timeline.height,
      frameRate: timeline.frameRate,
      durationUs: timeline.durationUs,
    },
    tracks: timeline.tracks,
    notes: timeline.notes,
    markers: timeline.markers,
    transitions: timeline.transitions,
  };
}

export function listAssets(project: Project) {
  return project.assets.map((asset) => ({ ...asset }));
}

export function inspectAsset(project: Project, assetId: AssetId) {
  const asset = project.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);
  return structuredClone(asset);
}

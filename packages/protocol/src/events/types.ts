import type { ProjectId, TimeUs } from "@cinesim/core";

export type EditorEvent =
  | { type: "project.changed"; projectId: ProjectId; changedIds: string[] }
  | { type: "project.saved"; projectId: ProjectId }
  | { type: "playback.state"; playing: boolean; timeUs: TimeUs }
  | { type: "playback.frame"; timeUs: TimeUs; droppedFrames: number }
  | { type: "runtime.error"; code: string; message: string };

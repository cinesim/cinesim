import { nextId } from "../ids";
import type { ProjectId } from "../ids";
import type { Project } from "./types";

export interface CreateProjectOptions {
  id?: ProjectId;
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
    version: 1,
    id: options.id ?? projectId,
    name: options.name.trim() || "Untitled project",
    activeSequenceId: sequenceId,
    assets: [],
    sequences: [
      {
        id: sequenceId,
        name: "Main timeline",
        width: options.width ?? 1920,
        height: options.height ?? 1080,
        frameRate: options.frameRate ?? 30,
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

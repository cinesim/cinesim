import { describe, expect, it } from "vite-plus/test";
import { timeUs, type Project } from "@cinesim/core";
import type { VisualIndexObservation } from "@cinesim/project-io";
import { DEFAULT_TRANSFORM } from "../../../packages/core/test/project-fixtures";
import {
  mergeVisualObservations,
  projectScreenplayEntries,
  splitVisualObservation,
  type ScreenplayVisualAsset,
} from "../src/shared/screenplay";

const observation: VisualIndexObservation = {
  id: "observation_room",
  sourceInUs: 2_000_000,
  sourceOutUs: 4_000_000,
  description: "A wide shot of the interview room.",
  people: ["Ava"],
  tags: ["interview"],
};

function project(): Project {
  return {
    id: "project_screenplay",
    name: "Screenplay",
    activeSequenceId: "sequence_main",
    notes: [],
    assets: [
      {
        id: "asset_camera",
        kind: "video",
        name: "Camera",
        source: { kind: "local", path: "media/camera.mp4" },
        durationUs: timeUs(10_000_000),
        hasAudio: true,
      },
      {
        id: "asset_music",
        kind: "audio",
        name: "Score",
        source: { kind: "local", path: "media/score.wav" },
        durationUs: timeUs(10_000_000),
      },
    ],
    sequences: [
      {
        id: "sequence_main",
        name: "Main",
        width: 1920,
        height: 1080,
        frameRate: 30,
        notes: [
          { id: "note_scene", kind: "scene", text: "INT. INTERVIEW ROOM — DAY", atUs: timeUs(0) },
        ],
        tracks: [
          {
            id: "track_video",
            name: "Video",
            kind: "video",
            muted: false,
            locked: false,
            clips: [
              {
                id: "clip_camera",
                assetId: "asset_camera",
                mediaKind: "video",
                timelineStartUs: timeUs(1_000_000),
                sourceStartUs: timeUs(1_000_000),
                sourceEndUs: timeUs(5_000_000),
                transform: DEFAULT_TRANSFORM,
              },
            ],
          },
          {
            id: "track_audio",
            name: "Audio",
            kind: "audio",
            muted: false,
            locked: false,
            clips: [
              {
                id: "clip_music",
                assetId: "asset_music",
                mediaKind: "audio",
                timelineStartUs: timeUs(0),
                sourceStartUs: timeUs(0),
                sourceEndUs: timeUs(5_000_000),
                transform: DEFAULT_TRANSFORM,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("screenplay projection", () => {
  it("projects scene, action, support, and explicit uncovered visual ranges", () => {
    const visuals = new Map<string, ScreenplayVisualAsset>([
      [
        "asset_camera",
        {
          status: {
            assetId: "asset_camera",
            state: "current",
            observationCount: 1,
            coverage: [{ sourceInUs: 2_000_000, sourceOutUs: 4_000_000 }],
          },
          observations: [observation],
        },
      ],
    ]);

    const entries = projectScreenplayEntries(project(), "sequence_main", visuals);
    expect(entries.map(({ kind }) => kind)).toEqual([
      "scene",
      "support",
      "visual-coverage",
      "action",
      "visual-coverage",
    ]);
    expect(entries.find(({ kind }) => kind === "action")).toMatchObject({
      timelineStartUs: 2_000_000,
      timelineEndUs: 4_000_000,
    });
  });

  it("splits with deterministic IDs and merges editable observation data", () => {
    const split = splitVisualObservation(observation, new Set(["observation_room_split_3000000"]));
    expect(split).toMatchObject([
      { id: observation.id, sourceOutUs: 3_000_000 },
      { id: "observation_room_split_3000000_2", sourceInUs: 3_000_000 },
    ]);
    expect(
      mergeVisualObservations(observation, {
        ...observation,
        id: "observation_close",
        sourceInUs: 4_000_000,
        sourceOutUs: 5_000_000,
        description: "A close reaction.",
        people: ["Ben"],
      }),
    ).toMatchObject({
      id: observation.id,
      sourceInUs: 2_000_000,
      sourceOutUs: 5_000_000,
      description: "A wide shot of the interview room. A close reaction.",
      people: ["Ava", "Ben"],
      provenance: "ui-merge",
    });
  });
});

import { describe, expect, it } from "vitest";
import { applyCommand, clipEndUs, createProject, findClip, nextId, ProjectHistory } from "../src";
import type { Asset, Project } from "../src";

const asset: Asset = {
  id: "asset_000001",
  kind: "video",
  name: "shot.mp4",
  source: { kind: "local", path: "/media/shot.mp4" },
  durationUs: 10_000_000,
  width: 1920,
  height: 1080,
  hasAudio: true,
};

const audioAsset: Asset = {
  id: "asset_000002",
  kind: "audio",
  name: "dialogue.wav",
  source: { kind: "local", path: "/media/dialogue.wav" },
  durationUs: 5_000_000,
};

function seededProject(): Project {
  const created = createProject({ name: "Test" });
  return applyCommand(created, { type: "asset.import", asset }).project;
}

function withClip(): Project {
  const project = seededProject();
  return applyCommand(project, {
    type: "clip.add",
    trackId: project.sequences[0]!.tracks[0]!.id,
    assetId: asset.id,
    timelineStartUs: 0,
  }).project;
}

describe("editing commands", () => {
  it("adds, updates, reorders, and removes tracks through deterministic commands", () => {
    const initial = seededProject();
    const sequenceId = initial.activeSequenceId;
    let result = applyCommand(initial, { type: "track.add", sequenceId, kind: "video" });
    expect(result.createdIds).toEqual(["track_000003"]);
    expect(result.project.sequences[0]!.tracks[2]).toMatchObject({
      id: "track_000003",
      name: "Video 2",
      kind: "video",
      muted: false,
      locked: false,
    });
    expect(initial.sequences[0]!.tracks).toHaveLength(2);

    result = applyCommand(result.project, {
      type: "track.update",
      trackId: "track_000003",
      name: "  B-roll  ",
      muted: true,
      locked: true,
    });
    expect(result.project.sequences[0]!.tracks[2]).toMatchObject({
      name: "B-roll",
      muted: true,
      locked: true,
    });

    result = applyCommand(result.project, {
      type: "track.update",
      trackId: "track_000003",
      locked: false,
    });
    result = applyCommand(result.project, {
      type: "track.reorder",
      trackId: "track_000003",
      index: 0,
    });
    expect(result.project.sequences[0]!.tracks.map((track) => track.id)).toEqual([
      "track_000003",
      "track_000001",
      "track_000002",
    ]);

    result = applyCommand(result.project, { type: "track.remove", trackId: "track_000003" });
    expect(result.project.sequences[0]!.tracks.map((track) => track.id)).toEqual([
      "track_000001",
      "track_000002",
    ]);
  });

  it("protects locked and non-empty tracks from structural removal", () => {
    const project = withClip();
    expect(() => applyCommand(project, { type: "track.remove", trackId: "track_000001" })).toThrow(
      /must be empty/,
    );

    const locked = applyCommand(project, {
      type: "track.update",
      trackId: "track_000002",
      locked: true,
    }).project;
    expect(() => applyCommand(locked, { type: "track.remove", trackId: "track_000002" })).toThrow(
      /locked/,
    );
    expect(() =>
      applyCommand(locked, { type: "track.reorder", trackId: "track_000002", index: 0 }),
    ).toThrow(/locked/);
  });

  it("requires meaningful track updates and valid reorder indexes", () => {
    const project = seededProject();
    expect(() => applyCommand(project, { type: "track.update", trackId: "track_000001" })).toThrow(
      /at least one field/,
    );
    expect(() =>
      applyCommand(project, { type: "track.update", trackId: "track_000001", name: "  " }),
    ).toThrow(/cannot be empty/);
    expect(() =>
      applyCommand(project, { type: "track.reorder", trackId: "track_000001", index: 2 }),
    ).toThrow(/between 0 and 1/);
  });

  it("adds clips using stable IDs", () => {
    const project = withClip();
    expect(findClip(project, "clip_000001").clip.sourceEndUs).toBe(10_000_000);
    expect(nextId("clip", ["clip_000001"])).toBe("clip_000002");
    expect(nextId("clip", ["clip_000002"])).toBe("clip_000003");
  });

  it("moves and trims clips in integer microseconds", () => {
    let project = withClip();
    project = applyCommand(project, {
      type: "clip.move",
      clipId: "clip_000001",
      timelineStartUs: 2_000_000,
    }).project;
    project = applyCommand(project, {
      type: "clip.trimStart",
      clipId: "clip_000001",
      atUs: 3_000_000,
    }).project;
    project = applyCommand(project, {
      type: "clip.trimEnd",
      clipId: "clip_000001",
      atUs: 8_000_000,
    }).project;
    const clip = findClip(project, "clip_000001").clip;
    expect(clip.timelineStartUs).toBe(3_000_000);
    expect(clip.sourceStartUs).toBe(1_000_000);
    expect(clipEndUs(clip)).toBe(8_000_000);
  });

  it("splits without changing the combined source range", () => {
    const project = applyCommand(withClip(), {
      type: "clip.split",
      clipId: "clip_000001",
      atUs: 4_250_000,
    }).project;
    const left = findClip(project, "clip_000001").clip;
    const right = findClip(project, "clip_000002").clip;
    expect(left.sourceEndUs).toBe(4_250_000);
    expect(right.sourceStartUs).toBe(4_250_000);
    expect(clipEndUs(right)).toBe(10_000_000);
  });

  it("rejects overlaps and invalid split points", () => {
    const project = withClip();
    const trackId = project.sequences[0]!.tracks[0]!.id;
    expect(() =>
      applyCommand(project, {
        type: "clip.add",
        trackId,
        assetId: asset.id,
        timelineStartUs: 5_000_000,
      }),
    ).toThrow(/overlaps/);
    expect(() =>
      applyCommand(project, { type: "clip.split", clipId: "clip_000001", atUs: 0 }),
    ).toThrow(/strictly inside/);
  });

  it("enforces asset compatibility when clips are added or moved between tracks", () => {
    let project = applyCommand(seededProject(), {
      type: "asset.import",
      asset: audioAsset,
    }).project;
    expect(() =>
      applyCommand(project, {
        type: "clip.add",
        trackId: "track_000001",
        assetId: audioAsset.id,
        timelineStartUs: 0,
      }),
    ).toThrow(/audio tracks/);
    expect(() =>
      applyCommand(project, {
        type: "clip.add",
        trackId: "track_000002",
        assetId: asset.id,
        timelineStartUs: 0,
      }),
    ).toThrow(/video or overlay tracks/);

    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000002",
      assetId: audioAsset.id,
      timelineStartUs: 0,
    }).project;
    expect(() =>
      applyCommand(project, {
        type: "clip.move",
        clipId: "clip_000001",
        trackId: "track_000001",
        timelineStartUs: 0,
      }),
    ).toThrow(/audio tracks/);

    project = applyCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "overlay",
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      assetId: asset.id,
      timelineStartUs: 0,
    }).project;
    project = applyCommand(project, {
      type: "clip.move",
      clipId: "clip_000002",
      trackId: "track_000003",
      timelineStartUs: 1_000_000,
    }).project;
    expect(findClip(project, "clip_000002").track.kind).toBe("overlay");
  });

  it("undoes and redoes committed transactions", () => {
    const project = seededProject();
    const history = new ProjectHistory(project);
    history.commit({
      type: "clip.add",
      trackId: project.sequences[0]!.tracks[0]!.id,
      assetId: asset.id,
      timelineStartUs: 0,
    });
    expect(history.canUndo).toBe(true);
    expect(history.undo().sequences[0]!.tracks[0]!.clips).toHaveLength(0);
    expect(history.redo().sequences[0]!.tracks[0]!.clips).toHaveLength(1);
  });
});

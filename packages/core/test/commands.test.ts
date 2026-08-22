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

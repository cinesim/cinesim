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
  hasAudio: false,
};

const avAsset: Asset = { ...asset, hasAudio: true };

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
  it("creates an immutable cloud project kind and switches asset sources through commands", () => {
    let project = createProject({
      name: "Cloud",
      cloudProjectId: "cloud_project_01hzy3w3fq1h7z6y7rj3a2bcde",
    });
    project = applyCommand(project, { type: "asset.import", asset }).project;
    expect(project.cloudProjectId).toBe("cloud_project_01hzy3w3fq1h7z6y7rj3a2bcde");

    project = applyCommand(project, {
      type: "asset.setSource",
      assetId: asset.id,
      source: { kind: "cloud", cloudAssetId: "cloud_asset_01hzy3w3fq1h7z6y7rj3a2bcde" },
    }).project;
    expect(project.assets[0]!.source).toEqual({
      kind: "cloud",
      cloudAssetId: "cloud_asset_01hzy3w3fq1h7z6y7rj3a2bcde",
    });
  });

  it("rejects cloud-backed assets in local projects", () => {
    const project = createProject({ name: "Local" });
    const cloudAsset: Asset = {
      ...asset,
      source: { kind: "cloud", cloudAssetId: "cloud_asset_01hzy3w3fq1h7z6y7rj3a2bcde" },
    };

    expect(() => applyCommand(project, { type: "asset.import", asset: cloudAsset })).toThrow(
      "Cloud-backed media can only be used in a cloud project",
    );
    const imported = applyCommand(project, { type: "asset.import", asset }).project;
    expect(() =>
      applyCommand(imported, {
        type: "asset.setSource",
        assetId: asset.id,
        source: cloudAsset.source,
      }),
    ).toThrow("Cloud-backed media can only be used in a cloud project");
  });

  it("adds, updates, reorders, and removes tracks through deterministic commands", () => {
    const initial = seededProject();
    const sequenceId = initial.activeSequenceId;
    let result = applyCommand(initial, { type: "track.add", sequenceId, kind: "video" });
    expect(result.createdIds).toEqual(["track_000003"]);
    expect(result.project.sequences[0]!.tracks[0]).toMatchObject({
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
    expect(result.project.sequences[0]!.tracks[0]).toMatchObject({
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
      index: 1,
    });
    expect(result.project.sequences[0]!.tracks.map((track) => track.id)).toEqual([
      "track_000001",
      "track_000003",
      "track_000002",
    ]);

    result = applyCommand(result.project, { type: "track.remove", trackId: "track_000003" });
    expect(result.project.sequences[0]!.tracks.map((track) => track.id)).toEqual([
      "track_000001",
      "track_000002",
    ]);
  });

  it("inserts visual tracks above and audio tracks below the existing stacks", () => {
    const project = seededProject();
    const withAudio = applyCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "audio",
    }).project;
    const withOverlay = applyCommand(withAudio, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "overlay",
    }).project;
    expect(withOverlay.sequences[0]!.tracks.map((track) => [track.name, track.kind])).toEqual([
      ["Overlay 1", "overlay"],
      ["Video 1", "video"],
      ["Audio 1", "audio"],
      ["Audio 2", "audio"],
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

  it("keeps linked video and audio components synchronized through edits", () => {
    let project = applyCommand(createProject({ name: "Linked" }), {
      type: "asset.import",
      asset: avAsset,
    }).project;
    const add = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      assetId: avAsset.id,
      timelineStartUs: 0,
    });
    project = add.project;
    expect(add.createdIds).toEqual(["clip_000001", "clip_000002"]);
    expect(findClip(project, "clip_000001").clip).toMatchObject({
      mediaKind: "video",
      linkedClipId: "clip_000002",
    });
    expect(findClip(project, "clip_000002").clip).toMatchObject({
      mediaKind: "audio",
      linkedClipId: "clip_000001",
    });

    project = applyCommand(project, {
      type: "clip.move",
      clipId: "clip_000002",
      timelineStartUs: 1_000_000,
    }).project;
    expect(findClip(project, "clip_000001").clip.timelineStartUs).toBe(1_000_000);
    expect(findClip(project, "clip_000002").clip.timelineStartUs).toBe(1_000_000);

    project = applyCommand(project, {
      type: "clip.trimStart",
      clipId: "clip_000001",
      atUs: 2_000_000,
    }).project;
    expect(findClip(project, "clip_000001").clip.sourceStartUs).toBe(1_000_000);
    expect(findClip(project, "clip_000002").clip.sourceStartUs).toBe(1_000_000);

    project = applyCommand(project, {
      type: "clip.split",
      clipId: "clip_000001",
      atUs: 5_000_000,
    }).project;
    expect(findClip(project, "clip_000003").clip.linkedClipId).toBe("clip_000004");
    expect(findClip(project, "clip_000004").clip.linkedClipId).toBe("clip_000003");

    project = applyCommand(project, { type: "clip.remove", clipId: "clip_000004" }).project;
    expect(() => findClip(project, "clip_000003")).toThrow(/not found/);
    expect(() => findClip(project, "clip_000004")).toThrow(/not found/);
  });

  it("adds linked components as one undoable command", () => {
    const project = applyCommand(createProject({ name: "Linked history" }), {
      type: "asset.import",
      asset: avAsset,
    }).project;
    const history = new ProjectHistory(project);
    history.commit({
      type: "clip.add",
      trackId: "track_000001",
      audioTrackId: "track_000002",
      assetId: avAsset.id,
      timelineStartUs: 0,
    });
    expect(history.project.sequences[0]!.tracks.flatMap((track) => track.clips)).toHaveLength(2);
    expect(history.undo().sequences[0]!.tracks.flatMap((track) => track.clips)).toHaveLength(0);
    expect(history.redo().sequences[0]!.tracks.flatMap((track) => track.clips)).toHaveLength(2);
  });

  it("creates an audio track atomically when no unlocked destination is available", () => {
    let project = applyCommand(createProject({ name: "Automatic audio track" }), {
      type: "asset.import",
      asset: avAsset,
    }).project;
    project = applyCommand(project, {
      type: "track.update",
      trackId: "track_000002",
      locked: true,
    }).project;
    const added = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      assetId: avAsset.id,
      timelineStartUs: 0,
    });
    expect(added.createdIds).toEqual(["track_000003", "clip_000001", "clip_000002"]);
    expect(added.project.sequences[0]!.tracks[2]).toMatchObject({
      id: "track_000003",
      name: "Audio 2",
      kind: "audio",
    });
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

  it("creates a timeline from ordered assets as one deterministic command", () => {
    let project = applyCommand(createProject({ name: "Assembly" }), {
      type: "asset.import",
      asset: avAsset,
    }).project;
    project = applyCommand(project, { type: "asset.import", asset: audioAsset }).project;

    const created = applyCommand(project, {
      type: "sequence.createFromAssets",
      assetIds: [audioAsset.id, avAsset.id],
      name: "Selects",
    });
    const sequence = created.project.sequences.find(
      (candidate) => candidate.id === created.project.activeSequenceId,
    )!;

    expect(sequence).toMatchObject({
      id: "sequence_000002",
      name: "Selects",
      width: 1920,
      height: 1080,
      frameRate: 30,
    });
    expect(sequence.tracks.map((track) => [track.id, track.kind])).toEqual([
      ["track_000003", "video"],
      ["track_000004", "audio"],
    ]);
    expect(sequence.tracks[0]!.clips).toMatchObject([
      {
        id: "clip_000002",
        assetId: avAsset.id,
        timelineStartUs: audioAsset.durationUs,
        linkedClipId: "clip_000003",
      },
    ]);
    expect(sequence.tracks[1]!.clips).toMatchObject([
      { id: "clip_000001", assetId: audioAsset.id, timelineStartUs: 0 },
      {
        id: "clip_000003",
        assetId: avAsset.id,
        timelineStartUs: audioAsset.durationUs,
        linkedClipId: "clip_000002",
      },
    ]);
    expect(created.createdIds).toEqual([
      "sequence_000002",
      "track_000003",
      "track_000004",
      "clip_000001",
      "clip_000002",
      "clip_000003",
    ]);
  });

  it("removes assets and every usage in one undoable command", () => {
    const history = new ProjectHistory(withClip());

    history.commit({ type: "asset.remove", assetIds: [asset.id] });
    expect(history.project.assets).toHaveLength(0);
    expect(history.project.sequences[0]!.tracks[0]!.clips).toHaveLength(0);

    const restored = history.undo();
    expect(restored.assets).toEqual([asset]);
    expect(restored.sequences[0]!.tracks[0]!.clips).toHaveLength(1);
  });

  it("protects asset usages on locked tracks", () => {
    const locked = applyCommand(withClip(), {
      type: "track.update",
      trackId: "track_000001",
      locked: true,
    }).project;

    expect(() => applyCommand(locked, { type: "asset.remove", assetIds: [asset.id] })).toThrow(
      /locked track/,
    );
  });

  it("removes timelines with a deterministic active fallback and protects the last timeline", () => {
    const history = new ProjectHistory(seededProject());
    const added = history.commit({
      type: "sequence.createFromAssets",
      assetIds: [asset.id],
      name: "Second",
    });
    const removedId = added.project.activeSequenceId;

    history.commit({ type: "sequence.remove", sequenceId: removedId });
    expect(history.project.sequences.map((sequence) => sequence.id)).toEqual(["sequence_000001"]);
    expect(history.project.activeSequenceId).toBe("sequence_000001");
    expect(() =>
      applyCommand(history.project, {
        type: "sequence.remove",
        sequenceId: "sequence_000001",
      }),
    ).toThrow(/at least one timeline/);

    expect(history.undo().sequences).toHaveLength(2);
  });
});

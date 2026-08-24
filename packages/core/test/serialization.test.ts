import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createProject,
  joinProjectFiles,
  splitProjectFiles,
  stableJson,
} from "../src";
import type { Asset } from "../src";

describe("canonical serialization", () => {
  it("round-trips deterministic split files", () => {
    const asset: Asset = {
      id: "asset_000001",
      kind: "video",
      name: "a.mp4",
      source: { kind: "local", path: "/tmp/a.mp4" },
      durationUs: 1_000_000,
    };
    const project = applyCommand(createProject({ name: "Round trip" }), {
      type: "asset.import",
      asset,
    }).project;
    const files = splitProjectFiles(project);
    const loaded = joinProjectFiles(files.manifest, files.assets, files.timeline);
    expect(loaded).toEqual(project);
    expect(stableJson(files)).toBe(stableJson(splitProjectFiles(loaded)));
  });

  it("rejects future versions", () => {
    const files = splitProjectFiles(createProject({ name: "Future" }));
    expect(() =>
      joinProjectFiles({ ...files.manifest, version: 2 }, files.assets, files.timeline),
    ).toThrow();
  });

  it("rejects broken asset references", () => {
    const files = splitProjectFiles(createProject({ name: "Broken" }));
    const timeline = structuredClone(files.timeline);
    timeline.sequences[0]!.tracks[0]!.clips.push({
      id: "clip_missing",
      assetId: "asset_missing",
      timelineStartUs: 0,
      sourceStartUs: 0,
      sourceEndUs: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, fit: "contain" },
    });
    expect(() => joinProjectFiles(files.manifest, files.assets, timeline)).toThrow(/missing asset/);
  });

  it("preserves authored track order across canonical save and load", () => {
    let project = createProject({ name: "Track order" });
    project = applyCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "overlay",
    }).project;
    project = applyCommand(project, {
      type: "track.reorder",
      trackId: "track_000003",
      index: 0,
    }).project;

    const files = splitProjectFiles(project);
    expect(files.timeline.sequences[0]!.tracks.map((track) => track.id)).toEqual([
      "track_000003",
      "track_000001",
      "track_000002",
    ]);
    expect(joinProjectFiles(files.manifest, files.assets, files.timeline)).toEqual(project);
  });

  it("rejects persisted clips on incompatible track kinds", () => {
    const audio: Asset = {
      id: "asset_000001",
      kind: "audio",
      name: "audio.wav",
      source: { kind: "local", path: "/tmp/audio.wav" },
      durationUs: 1_000_000,
    };
    const files = splitProjectFiles(
      applyCommand(createProject({ name: "Compatibility" }), {
        type: "asset.import",
        asset: audio,
      }).project,
    );
    files.timeline.sequences[0]!.tracks[0]!.clips.push({
      id: "clip_000001",
      assetId: audio.id,
      timelineStartUs: 0,
      sourceStartUs: 0,
      sourceEndUs: audio.durationUs,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, fit: "contain" },
    });
    expect(() => joinProjectFiles(files.manifest, files.assets, files.timeline)).toThrow(
      /incompatible audio media/,
    );
  });
});

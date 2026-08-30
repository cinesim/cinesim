import { timeUs } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import {
  applyCommand,
  createProject,
  joinProjectFiles,
  splitProjectFiles,
  stableJson,
  settingsFromToml,
  settingsToToml,
} from "../src";
import type { Asset } from "../src";

describe("canonical serialization", () => {
  it("round-trips deterministic split files", () => {
    const asset: Asset = {
      id: "asset_000001",
      kind: "video",
      name: "a.mp4",
      source: { kind: "local", path: "/tmp/a.mp4" },
      durationUs: timeUs(1_000_000),
    };
    let project = applyCommand(createProject({ name: "Round trip" }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      assetId: asset.id,
      timelineStartUs: timeUs(0),
    }).project;
    project = applyCommand(project, {
      type: "clip.setFade",
      clipId: "clip_000001",
      edge: "in",
      durationUs: timeUs(200_000),
    }).project;
    const files = splitProjectFiles(project);
    const loaded = joinProjectFiles(files.manifest, files.assets, files.timeline);
    expect(loaded).toEqual(project);
    expect(stableJson(files)).toBe(stableJson(splitProjectFiles(loaded)));
  });

  it("round-trips opaque cloud project and asset references", () => {
    const asset: Asset = {
      id: "asset_000001",
      kind: "video",
      name: "cloud.mov",
      source: { kind: "cloud", cloudAssetId: "cloud_asset_01hzy3w3fq1h7z6y7rj3a2bcde" },
      durationUs: timeUs(1_000_000),
    };
    let project = createProject({
      name: "Cloud",
      cloudProjectId: "cloud_project_01hzy3w3fq1h7z6y7rj3a2bcde",
    });
    project = applyCommand(project, { type: "asset.import", asset }).project;
    const files = splitProjectFiles(project);
    expect(files.manifest.cloudProjectId).toBe(project.cloudProjectId);
    expect(joinProjectFiles(files.manifest, files.assets, files.timeline)).toEqual(project);
    expect(stableJson(files)).not.toContain("r2.cloudflarestorage.com");
  });

  it("migrates legacy settings to the balanced automatic proxy defaults", () => {
    const settings = settingsFromToml(
      `version = 1\nautosave = true\n\n[preview]\nquality = "half"\nbackground_color = "#09090b"\n\n[perception]\nfilmstrip_interval_seconds = 5\n`,
    );
    expect(settings).toMatchObject({
      proxyGeneration: "automatic",
      proxyProfile: "balanced",
      proxyMaxLongEdge: 1280,
      proxyFrameRateCap: 60,
      proxyQuality: "medium",
    });
    expect(settingsFromToml(settingsToToml(settings))).toEqual(settings);
  });

  it("rejects future versions", () => {
    const files = splitProjectFiles(createProject({ name: "Future" }));
    expect(() =>
      joinProjectFiles({ ...files.manifest, version: 2 }, files.assets, files.timeline),
    ).toThrow();
  });

  it("rejects persisted fades that overlap", () => {
    const asset: Asset = {
      id: "asset_000001",
      kind: "video",
      name: "fade.mov",
      source: { kind: "local", path: "/tmp/fade.mov" },
      durationUs: timeUs(1_000_000),
    };
    let project = applyCommand(createProject({ name: "Invalid fade" }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      assetId: asset.id,
      timelineStartUs: timeUs(0),
    }).project;
    const files = splitProjectFiles(project);
    Object.assign(files.timeline.sequences[0]!.tracks[0]!.clips[0]!, {
      fadeInUs: timeUs(600_000),
      fadeOutUs: timeUs(600_000),
    });
    expect(() => joinProjectFiles(files.manifest, files.assets, files.timeline)).toThrow(
      /overlapping fades/,
    );
  });

  it("rejects broken asset references", () => {
    const files = splitProjectFiles(createProject({ name: "Broken" }));
    const timeline = structuredClone(files.timeline);
    timeline.sequences[0]!.tracks[0]!.clips.push({
      id: "clip_missing",
      assetId: "asset_missing",
      mediaKind: "video",
      timelineStartUs: timeUs(0),
      sourceStartUs: timeUs(0),
      sourceEndUs: timeUs(1),
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
      index: 1,
    }).project;

    const files = splitProjectFiles(project);
    expect(files.timeline.sequences[0]!.tracks.map((track) => track.id)).toEqual([
      "track_000001",
      "track_000003",
      "track_000002",
    ]);
    expect(joinProjectFiles(files.manifest, files.assets, files.timeline)).toEqual(project);
  });

  it("upgrades embedded A/V clips into explicit linked components", () => {
    const asset: Asset = {
      id: "asset_000001",
      kind: "video",
      name: "legacy.mov",
      source: { kind: "local", path: "/tmp/legacy.mov" },
      durationUs: timeUs(1_000_000),
      hasAudio: true,
    };
    const files = splitProjectFiles(
      applyCommand(createProject({ name: "Upgrade" }), {
        type: "asset.import",
        asset,
      }).project,
    );
    const timeline = structuredClone(files.timeline) as unknown as {
      sequences: Array<{ tracks: Array<{ clips: Array<Record<string, unknown>> }> }>;
    };
    timeline.sequences[0]!.tracks[0]!.clips.push({
      id: "clip_000001",
      assetId: asset.id,
      timelineStartUs: timeUs(0),
      sourceStartUs: timeUs(0),
      sourceEndUs: timeUs(asset.durationUs),
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, fit: "contain" },
    });

    const loaded = joinProjectFiles(files.manifest, files.assets, timeline);
    expect(loaded.sequences[0]!.tracks[0]!.clips[0]).toMatchObject({
      id: "clip_000001",
      mediaKind: "video",
      linkedClipId: "clip_000002",
    });
    expect(loaded.sequences[0]!.tracks[1]!.clips[0]).toMatchObject({
      id: "clip_000002",
      mediaKind: "audio",
      linkedClipId: "clip_000001",
    });
  });

  it("rejects persisted clips on incompatible track kinds", () => {
    const audio: Asset = {
      id: "asset_000001",
      kind: "audio",
      name: "audio.wav",
      source: { kind: "local", path: "/tmp/audio.wav" },
      durationUs: timeUs(1_000_000),
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
      mediaKind: "audio",
      timelineStartUs: timeUs(0),
      sourceStartUs: timeUs(0),
      sourceEndUs: timeUs(audio.durationUs),
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, fit: "contain" },
    });
    expect(() => joinProjectFiles(files.manifest, files.assets, files.timeline)).toThrow(
      /incompatible audio media/,
    );
  });
});

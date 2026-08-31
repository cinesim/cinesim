import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SETTINGS,
  DEFAULT_TRANSFORM,
  assertV1IrEquivalent,
  createProject,
  irToV1Project,
  timeUs,
  v1ProjectToIr,
} from "@cinesim/core";

describe("format-v1 semantic migration boundary", () => {
  it("losslessly represents current sequences, tracks, clips, transforms, fades, and links", () => {
    const project = createProject({ id: "project_fixture", name: "Fixture" });
    const [videoTrack, audioTrack] = project.sequences[0]!.tracks;
    project.assets.push({
      id: "asset_camera",
      kind: "video",
      name: "Camera",
      source: { kind: "local", path: "/tmp/camera.mov" },
      durationUs: timeUs(10_000_000),
      width: 1920,
      height: 1080,
      frameRate: 29.97,
      hasAudio: true,
    });
    videoTrack!.clips.push({
      id: "clip_video",
      assetId: "asset_camera",
      mediaKind: "video",
      linkedClipId: "clip_audio",
      timelineStartUs: timeUs(1_000_000),
      sourceStartUs: timeUs(2_000_000),
      sourceEndUs: timeUs(7_000_000),
      fadeInUs: timeUs(100_000),
      fadeOutUs: timeUs(200_000),
      transform: { ...DEFAULT_TRANSFORM, x: 12, y: 20, scaleX: 1.2, opacity: 0.8, fit: "cover" },
    });
    audioTrack!.clips.push({
      id: "clip_audio",
      assetId: "asset_camera",
      mediaKind: "audio",
      linkedClipId: "clip_video",
      timelineStartUs: timeUs(1_000_000),
      sourceStartUs: timeUs(2_000_000),
      sourceEndUs: timeUs(7_000_000),
      fadeInUs: timeUs(100_000),
      fadeOutUs: timeUs(200_000),
      transform: DEFAULT_TRANSFORM,
    });
    const ir = v1ProjectToIr(project, DEFAULT_SETTINGS);
    expect(ir.referencedAssetIds).toEqual(["asset_camera"]);
    expect(ir.compositions[0]!.timeline.tracks[0]!.clips[0]).toMatchObject({
      id: "clip_video",
      sourceStartUs: 2_000_000,
      durationUs: 5_000_000,
      linkedClipId: "clip_audio",
    });
    const roundTrip = irToV1Project(ir, { name: project.name, assets: project.assets });
    expect(roundTrip).toEqual(project);
    expect(() => assertV1IrEquivalent(project, DEFAULT_SETTINGS, ir)).not.toThrow();
  });
});

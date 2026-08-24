import { describe, expect, it } from "vitest";
import { applyCommand, createProject } from "@cinesim/core";
import type { Asset, Project } from "@cinesim/core";
import {
  proposeAssetDrop,
  proposeClipMove,
  quantizeToFrame,
  snapTimelineTime,
  trackAcceptsAsset,
} from "../src/renderer/interactions/timeline-geometry";

const video: Asset = {
  id: "asset_video",
  kind: "video",
  name: "Video.mov",
  source: { kind: "local", path: "/media/video.mov" },
  durationUs: 2_000_000,
  hasAudio: true,
};
const audio: Asset = {
  id: "asset_audio",
  kind: "audio",
  name: "Audio.wav",
  source: { kind: "local", path: "/media/audio.wav" },
  durationUs: 1_000_000,
  hasAudio: true,
};

function fixture(): Project {
  let project = createProject({ name: "Geometry", frameRate: 30 });
  project = applyCommand(project, { type: "asset.import", asset: video }).project;
  project = applyCommand(project, { type: "asset.import", asset: audio }).project;
  return project;
}

describe("timeline interaction geometry", () => {
  it("quantizes proposed edits to sequence frames and nearby edit points", () => {
    expect(quantizeToFrame(49_000, 30)).toBe(33_333);
    expect(snapTimelineTime(980_000, 30, [1_000_000], 50_000)).toEqual({
      timeUs: 1_000_000,
      snapped: true,
    });
  });

  it("enforces track compatibility before a canonical command is submitted", () => {
    const project = fixture();
    const [videoTrack, audioTrack] = project.sequences[0]!.tracks;
    expect(trackAcceptsAsset(videoTrack!, video)).toBe(true);
    expect(trackAcceptsAsset(audioTrack!, video)).toBe(false);
    expect(proposeAssetDrop(project, video.id, audioTrack!.id, 0)).toMatchObject({
      valid: false,
      reason: "incompatible-track",
    });
  });

  it("reports collisions while preserving the full proposed duration", () => {
    let project = fixture();
    const videoTrack = project.sequences[0]!.tracks[0]!;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: videoTrack.id,
      assetId: video.id,
      timelineStartUs: 0,
    }).project;
    const proposal = proposeAssetDrop(project, video.id, videoTrack.id, 1_000_000);
    expect(proposal).toMatchObject({
      timelineStartUs: 1_000_000,
      timelineEndUs: 3_000_000,
      valid: false,
      reason: "overlap",
    });
  });

  it("allows a clip to move across compatible tracks without colliding with itself", () => {
    let project = fixture();
    const firstTrack = project.sequences[0]!.tracks[0]!;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: firstTrack.id,
      assetId: video.id,
      timelineStartUs: 0,
    }).project;
    const clip = project.sequences[0]!.tracks[0]!.clips[0]!;
    expect(proposeClipMove(project, clip.id, firstTrack.id, 1_000_000)).toMatchObject({
      valid: true,
      timelineStartUs: 1_000_000,
      timelineEndUs: 3_000_000,
    });
  });
});

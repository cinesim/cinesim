import { describe, expect, it } from "vite-plus/test";
import { timeUs } from "@cinesim/core";
import type { Asset, Project } from "@cinesim/core";
import { applyCommand, createProject } from "../../../packages/core/test/project-fixtures";
import {
  commandForTimelineDrop,
  isNoopClipMove,
  proposeAssetDrop,
  proposeClipMove,
  quantizeToFrame,
  snapTimelineRange,
  snapTimelineTime,
} from "../src/renderer/lib/timeline-geometry";

const video: Asset = {
  id: "asset_video",
  kind: "video",
  name: "Video.mov",
  source: { kind: "local", path: "/media/video.mov" },
  durationUs: timeUs(2_000_000),
  hasAudio: true,
};
const audio: Asset = {
  id: "asset_audio",
  kind: "audio",
  name: "Audio.wav",
  source: { kind: "local", path: "/media/audio.wav" },
  durationUs: timeUs(1_000_000),
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
    expect(quantizeToFrame(timeUs(49_000), 30)).toBe(33_333);
    expect(snapTimelineTime(timeUs(980_000), 30, [timeUs(1_000_000)], timeUs(50_000))).toEqual({
      timeUs: 1_000_000,
      snapped: true,
      snapPointUs: 1_000_000,
    });
    expect(
      snapTimelineRange(
        timeUs(1_080_000),
        timeUs(1_000_000),
        30,
        [timeUs(2_000_000)],
        timeUs(100_000),
      ),
    ).toEqual({ timeUs: 1_000_000, snapped: true, snapPointUs: 2_000_000 });
  });

  it("enforces track compatibility before a canonical command is submitted", () => {
    const project = fixture();
    const audioTrack = project.sequences[0]!.tracks[1];
    expect(proposeAssetDrop(project, video.id, audioTrack!.id, timeUs(0))).toMatchObject({
      valid: false,
      reason: "incompatible-track",
    });
  });

  it("proposes one atomic linked A/V add across video and audio tracks", () => {
    const project = fixture();
    const videoTrack = project.sequences[0]!.tracks[0]!;
    const audioTrack = project.sequences[0]!.tracks[1]!;
    const proposal = proposeAssetDrop(project, video.id, videoTrack.id, timeUs(0))!;
    expect(proposal).toMatchObject({ valid: true, audioTrackId: audioTrack.id });
    expect(commandForTimelineDrop(project, { kind: "asset", assetId: video.id }, proposal)).toEqual(
      {
        type: "clip.add",
        trackId: videoTrack.id,
        audioTrackId: audioTrack.id,
        assetId: video.id,
        timelineStartUs: timeUs(0),
      },
    );
  });

  it("reports collisions while preserving the full proposed duration", () => {
    let project = fixture();
    const videoTrack = project.sequences[0]!.tracks[0]!;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: videoTrack.id,
      assetId: video.id,
      timelineStartUs: timeUs(0),
    }).project;
    const proposal = proposeAssetDrop(project, video.id, videoTrack.id, timeUs(1_000_000));
    expect(proposal).toMatchObject({
      timelineStartUs: timeUs(1_000_000),
      timelineEndUs: timeUs(3_000_000),
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
      timelineStartUs: timeUs(0),
    }).project;
    const clip = project.sequences[0]!.tracks[0]!.clips[0]!;
    expect(proposeClipMove(project, clip.id, firstTrack.id, timeUs(1_000_000))).toMatchObject({
      valid: true,
      timelineStartUs: timeUs(1_000_000),
      timelineEndUs: timeUs(3_000_000),
    });
    const unchanged = proposeClipMove(project, clip.id, firstTrack.id, clip.timelineStartUs)!;
    expect(isNoopClipMove(project, unchanged)).toBe(true);
    expect(isNoopClipMove(project, { ...unchanged, timelineStartUs: timeUs(1_000_000) })).toBe(
      false,
    );
    expect(
      commandForTimelineDrop(
        project,
        { kind: "clip", clipId: clip.id, trackId: firstTrack.id },
        unchanged,
      ),
    ).toBeNull();
    expect(
      commandForTimelineDrop(
        project,
        { kind: "clip", clipId: clip.id, trackId: firstTrack.id },
        null,
      ),
    ).toBeNull();
  });

  it("previews and commits linked video and audio moves as one command", () => {
    for (const component of ["video", "audio"] as const) {
      let project = fixture();
      const videoTrack = project.sequences[0]!.tracks[0]!;
      const audioTrack = project.sequences[0]!.tracks[1]!;
      project = applyCommand(project, {
        type: "clip.add",
        trackId: videoTrack.id,
        audioTrackId: audioTrack.id,
        assetId: video.id,
        timelineStartUs: timeUs(0),
      }).project;
      const track = component === "video" ? videoTrack : audioTrack;
      const clip = project.sequences[0]!.tracks.find(
        (candidate) => candidate.id === track.id,
      )!.clips.find((candidate) => candidate.mediaKind === component)!;
      const proposal = proposeClipMove(project, clip.id, track.id, timeUs(3_000_000))!;
      expect(proposal).toMatchObject({
        valid: true,
        linkedTrackId: track.id === videoTrack.id ? audioTrack.id : videoTrack.id,
        linkedTimelineStartUs: timeUs(3_000_000),
        linkedTimelineEndUs: timeUs(5_000_000),
      });
      const command = commandForTimelineDrop(
        project,
        { kind: "clip", clipId: clip.id, trackId: track.id },
        proposal,
      )!;
      project = applyCommand(project, command).project;
      expect(project.sequences[0]!.tracks[0]!.clips[0]!.timelineStartUs).toBe(3_000_000);
      expect(project.sequences[0]!.tracks[1]!.clips[0]!.timelineStartUs).toBe(3_000_000);
    }
  });
});

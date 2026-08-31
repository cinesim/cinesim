import { irTimeUs } from "@cinesim/ir";
import { describe, expect, it } from "vite-plus/test";
import {
  clipDurationUs,
  clipEndUs,
  millisecondsToTimeUs,
  projectViewFromIr,
  secondsToTimeUs,
  timeMilliseconds,
  timeSeconds,
  timeUs,
  timeUsToMilliseconds,
  timeUsToSeconds,
  type Asset,
  type TimeUs,
} from "../src";
import { applyCommand, createProject, projectToIr } from "./project-fixtures";

const asset: Asset = {
  id: "asset_camera",
  kind: "video",
  name: "Camera",
  source: { kind: "local", path: "/media/camera.mov" },
  durationUs: timeUs(10_000_000),
};

describe("project view primitives", () => {
  it("converts external clocks through explicit microsecond boundaries", () => {
    const acceptsTimeUs = (value: TimeUs): TimeUs => value;
    // @ts-expect-error A raw number must cross the validated microsecond boundary first.
    acceptsTimeUs(1);
    expect(acceptsTimeUs(timeUs(1))).toBe(1);
    expect(secondsToTimeUs(timeSeconds(1.25))).toBe(1_250_000);
    expect(millisecondsToTimeUs(timeMilliseconds(1.25))).toBe(1_250);
    expect(timeUsToSeconds(timeUs(2_500_000))).toBe(2.5);
    expect(timeUsToMilliseconds(timeUs(2_500))).toBe(2.5);
    expect(() => timeUs(-1)).toThrow(/non-negative safe integer/);
    expect(() => timeSeconds(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("projects canonical duration and playback rate without treating source span as duration", () => {
    let project = applyCommand(createProject({ name: "Speed" }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      assetId: asset.id,
      timelineStartUs: timeUs(1_000_000),
      sourceStartUs: timeUs(2_000_000),
      sourceEndUs: timeUs(6_000_000),
    }).project;
    const program = projectToIr(project);
    const irClip = program.compositions[0]!.timeline.tracks[0]!.clips[0]!;
    irClip.durationUs = irTimeUs(2_000_000);
    irClip.playbackRate = 2;
    const view = projectViewFromIr(program, { name: project.name, assets: project.assets });
    const clip = view.sequences[0]!.tracks[0]!.clips[0]!;
    expect(clip.durationUs).toBe(2_000_000);
    expect(clip.sourceEndUs).toBe(6_000_000);
    expect(clipDurationUs(clip)).toBe(2_000_000);
    expect(clipEndUs(clip)).toBe(3_000_000);
  });
});

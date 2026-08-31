import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeUs } from "@cinesim/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SourceCommandService, SourceProjectConflictError, SourceProjectRepository } from "../src";

const directories: string[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-source-commands-"));
  directories.push(directory);
  await SourceProjectRepository.create(directory, {
    id: "project_commands",
    name: "Commands",
  });
  const service = await SourceCommandService.open(directory);
  const imported = await service.execute({
    type: "asset.import",
    asset: {
      id: "asset_camera",
      kind: "video",
      name: "Camera",
      source: { kind: "local", path: "/tmp/camera.mov" },
      durationUs: timeUs(10_000_000),
      hasAudio: true,
    },
  });
  return { directory, service, imported };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("source-backed semantic commands", () => {
  it("adds linked media, moves, trims, fades, splits, and undo/redoes as source transactions", async () => {
    const { service } = await setup();
    const added = await service.execute({
      type: "clip.add",
      trackId: "track_video_1",
      audioTrackId: "track_audio_1",
      assetId: "asset_camera",
      timelineStartUs: timeUs(0),
      sourceStartUs: timeUs(1_000_000),
      sourceEndUs: timeUs(7_000_000),
    });
    expect(added.createdIds).toHaveLength(2);
    const [videoId, audioId] = added.createdIds as [`clip_${string}`, `clip_${string}`];
    expect(added.snapshot.sources["main.jsx"]).toContain(`linked=${JSON.stringify(audioId)}`);
    expect(
      added.snapshot.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
        (track) => track.clips,
      ),
    ).toHaveLength(2);

    await service.execute({
      type: "clip.move",
      clipId: videoId!,
      timelineStartUs: timeUs(2_000_000),
    });
    await service.execute({
      type: "clip.trimStart",
      clipId: videoId!,
      atUs: timeUs(3_000_000),
    });
    await service.execute({
      type: "clip.setFade",
      clipId: videoId!,
      edge: "in",
      durationUs: timeUs(250_000),
    });
    const split = await service.execute({
      type: "clip.split",
      clipId: videoId!,
      atUs: timeUs(5_000_000),
    });
    expect(split.createdIds).toHaveLength(2);
    expect(split.snapshot.sources["main.jsx"]).toContain("start={microseconds(5000000)}");
    const splitGeneration = split.snapshot.generation;
    const undone = await service.undo();
    expect(undone.generation).not.toBe(splitGeneration);
    expect(
      undone.compilation.ir.compositions[0]!.timeline.tracks.flatMap((track) => track.clips),
    ).toHaveLength(2);
    const redone = await service.redo();
    expect(
      redone.compilation.ir.compositions[0]!.timeline.tracks.flatMap((track) => track.clips),
    ).toHaveLength(4);
  });

  it("uses property bindings for minimal inspector edits and rejects stale sessions", async () => {
    const { service } = await setup();
    const before = service.snapshot.sources["main.jsx"]!;
    const updated = await service.execute({
      type: "track.update",
      trackId: "track_video_1",
      name: "Primary picture",
      muted: true,
    });
    const after = updated.snapshot.sources["main.jsx"]!;
    expect(after).toContain('name="Primary picture"');
    expect(after).toContain("muted={true}");
    expect(
      after
        .replace('name="Primary picture"', 'name="Video 1"')
        .replace("muted={true}", "muted={false}"),
    ).toBe(before);
    await expect(
      service.execute(
        { type: "track.update", trackId: "track_video_1", name: "Stale" },
        "stale-generation",
      ),
    ).rejects.toBeInstanceOf(SourceProjectConflictError);
  });

  it("commits one compound ripple edit and keeps reciprocal links", async () => {
    const { service } = await setup();
    const added = await service.execute({
      type: "clip.add",
      trackId: "track_video_1",
      audioTrackId: "track_audio_1",
      assetId: "asset_camera",
      timelineStartUs: timeUs(0),
      sourceEndUs: timeUs(8_000_000),
    });
    const result = await service.execute({
      type: "sequence.deleteRanges",
      sequenceId: "sequence_main",
      mode: "ripple",
      ranges: [
        { startUs: timeUs(2_000_000), endUs: timeUs(4_000_000) },
        { startUs: timeUs(6_000_000), endUs: timeUs(7_000_000) },
      ],
    });
    expect(result.snapshot.generation).not.toBe(added.snapshot.generation);
    const clips = result.snapshot.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
      (track) => track.clips,
    );
    expect(clips).toHaveLength(6);
    for (const clip of clips) {
      const linked = clips.find((candidate) => candidate.id === clip.linkedClipId);
      expect(linked?.linkedClipId).toBe(clip.id);
    }
  });
});

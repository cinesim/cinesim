import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("commits a keyframe gesture as one validated source transaction", async () => {
    const { directory, service } = await setup();
    const mainPath = join(directory, "main.jsx");
    const original = await readFile(mainPath, "utf8");
    const animated = original.replace(
      '<track id="track_video_1" kind="video" name="Video 1" muted={false} locked={false} />',
      '<track id="track_video_1" kind="video" name="Video 1" muted={false} locked={false}><clip id="clip_keyed" asset={asset("asset_camera")} media="video" start={seconds(0)} in={seconds(0)} duration={seconds(4)} x={px(0)}><animate property="x"><key at={seconds(0)} value={px(0)} /><key at={seconds(2)} value={px(50)} /></animate></clip></track>',
    );
    await writeFile(mainPath, animated);
    await service.acceptExternal(await service.repository.load());
    const result = await service.execute({
      type: "keyframe.set",
      nodeId: "clip_keyed",
      property: "x",
      index: 1,
      atUs: timeUs(3_000_000),
      value: { kind: "length", unit: "px", value: 100 },
    });
    const clip = result.snapshot.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
      (track) => track.clips,
    ).find(({ id }) => id === "clip_keyed");
    expect(clip?.animations?.[0]?.keyframes[1]).toMatchObject({
      at: 3_000_000,
      value: { value: 100 },
    });
    expect(result.snapshot.sources["main.jsx"]).toContain(
      "<key at={microseconds(3000000)} value={px(100)} />",
    );
    const undone = await service.undo();
    expect(undone.sources["main.jsx"]).toContain("<key at={seconds(2)} value={px(50)} />");
  });

  it("records accepted filesystem generations in global undo and restores complete source sets", async () => {
    const { directory, service } = await setup();
    const mainPath = join(directory, "main.jsx");
    const extraPath = join(directory, "Extra.jsx");
    const originalMain = await readFile(mainPath, "utf8");
    const withExtra = `import { Extra } from "./Extra.jsx";\n${originalMain.replace(
      '<track id="track_overlay_1" kind="overlay" name="Titles" muted={false} locked={false} />',
      '<track id="track_overlay_1" kind="overlay" name="Titles" muted={false} locked={false}><clip id="clip_external" start={seconds(0)} duration={seconds(1)}><Extra id="external" /></clip></track>',
    )}`;
    await Promise.all([
      writeFile(
        extraPath,
        'export function Extra() { return <rect id="panel" width={px(100)} height={px(100)} />; }\n',
      ),
      writeFile(mainPath, withExtra),
    ]);
    const withExtraSnapshot = await service.repository.load();
    await service.acceptExternal(withExtraSnapshot);
    expect(service.canUndo).toBe(true);
    expect(Object.keys(service.snapshot.sources)).toContain("Extra.jsx");

    await writeFile(mainPath, originalMain.replace('name="Main timeline"', 'name="Disk edit"'));
    const withoutExtraSnapshot = await service.repository.load();
    await service.acceptExternal(withoutExtraSnapshot);
    expect(Object.keys(service.snapshot.sources)).not.toContain("Extra.jsx");

    const reopened = await SourceCommandService.open(directory);
    expect(reopened.canUndo).toBe(true);
    const restored = await reopened.undo();
    expect(restored.sources["Extra.jsx"]).toBeDefined();
    const redone = await reopened.redo();
    expect(redone.sources["Extra.jsx"]).toBeUndefined();
    await expect(readFile(extraPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("commits linked audio split edits atomically and preserves independent mixing properties", async () => {
    const { service } = await setup();
    const added = await service.execute({
      type: "clip.add",
      trackId: "track_video_1",
      audioTrackId: "track_audio_1",
      assetId: "asset_camera",
      timelineStartUs: timeUs(2_000_000),
      sourceStartUs: timeUs(2_000_000),
      sourceEndUs: timeUs(8_000_000),
    });
    const [videoId, audioId] = added.createdIds;
    const split = await service.execute({
      type: "clip.splitEdit",
      clipId: videoId! as `clip_${string}`,
      component: "audio",
      edge: "start",
      atUs: timeUs(1_000_000),
    });
    const clips = split.snapshot.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
      ({ clips }) => clips,
    );
    expect(clips.find(({ id }) => id === audioId)).toMatchObject({
      linkedClipId: videoId,
      timelineStartUs: 1_000_000,
      sourceStartUs: 1_000_000,
      durationUs: 7_000_000,
    });
    expect(clips.find(({ id }) => id === videoId)).toMatchObject({
      linkedClipId: audioId,
      timelineStartUs: 2_000_000,
      durationUs: 6_000_000,
    });
    const mixed = await service.execute({
      type: "property.setMany",
      nodeId: audioId!,
      updates: [
        { property: "gain", value: { kind: "decibels", value: -4.5 } },
        { property: "pan", value: { kind: "number", value: -0.25 } },
      ],
    });
    expect(
      mixed.snapshot.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
        ({ clips }) => clips,
      ).find(({ id }) => id === audioId)?.audio,
    ).toMatchObject({ gainDb: -4.5, pan: -0.25 });
    const undone = await service.undo();
    expect(
      undone.compilation.ir.compositions[0]!.timeline.tracks.flatMap(({ clips }) => clips).find(
        ({ id }) => id === audioId,
      )?.audio,
    ).toMatchObject({ gainDb: 0, pan: 0 });
    const splitUndone = await service.undo();
    expect(
      splitUndone.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
        ({ clips }) => clips,
      ).find(({ id }) => id === audioId),
    ).toMatchObject({
      timelineStartUs: 2_000_000,
      sourceStartUs: 2_000_000,
      durationUs: 6_000_000,
    });
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

  it("commits a direct transform gesture as one source transaction", async () => {
    const { service } = await setup();
    const added = await service.execute({
      type: "clip.add",
      trackId: "track_video_1",
      assetId: "asset_camera",
      timelineStartUs: timeUs(0),
    });
    const clipId = added.createdIds[0]!;
    const transformed = await service.execute({
      type: "property.setMany",
      nodeId: clipId,
      scope: "instance",
      updates: [
        { property: "x", value: { kind: "length", unit: "px", value: 120 } },
        { property: "y", value: { kind: "length", unit: "px", value: -40 } },
        { property: "scaleX", value: { kind: "number", value: 0.75 } },
        { property: "scaleY", value: { kind: "number", value: 0.75 } },
        { property: "rotation", value: { kind: "angle", unit: "deg", value: 15 } },
      ],
    });
    const clip = transformed.snapshot.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
      (track) => track.clips,
    ).find((candidate) => candidate.id === clipId)!;
    expect(clip.transform).toMatchObject({
      x: 120,
      y: -40,
      scaleX: 0.75,
      scaleY: 0.75,
      rotation: 15,
    });
    expect(transformed.snapshot.sources["main.jsx"]).toContain("x={px(120)}");

    const undone = await service.undo();
    const restored = undone.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
      (track) => track.clips,
    ).find((candidate) => candidate.id === clipId)!;
    expect(restored.transform).toMatchObject({
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    });
  });

  it("edits component invocations and inserts inherited instance overrides", async () => {
    const { directory, service: initialService } = await setup();
    const main = `import { Card } from "./Card.jsx";
export const main = (
  <composition id="sequence_main" width={1920} height={1080} fps={30}>
    <timeline id="timeline_main">
      <track id="track_overlay_1" kind="overlay" name="Titles">
        <clip id="clip_title" start={seconds(0)} duration={seconds(2)}>
          <Card id="title" text="Hello" />
        </clip>
      </track>
    </timeline>
  </composition>
);
export default main;
`;
    const component = `export function Card({ text, accent = "#ff0000" }) {
  return (
    <group id="root">
      <rect id="panel" width={px(400)} height={px(100)} fill={accent} />
      <text id="label" text={text} color="#ffffff" fontSize={px(40)} />
    </group>
  );
}
`;
    await initialService.repository.commit({
      expectedGeneration: initialService.snapshot.generation,
      sources: { "main.jsx": main, "Card.jsx": component },
    });
    const service = await SourceCommandService.open(directory);

    const textEdit = await service.execute({
      type: "property.set",
      nodeId: "title/label",
      property: "text",
      value: { kind: "string", value: "World" },
      scope: "instance",
    });
    expect(textEdit.snapshot.sources["main.jsx"]).toContain('<Card id="title" text="World" />');
    expect(textEdit.snapshot.sources["Card.jsx"]).toBe(component);

    const inheritedEdit = await service.execute({
      type: "property.set",
      nodeId: "title/panel",
      property: "fill",
      value: { kind: "color", value: "#00ff00" },
      scope: "instance",
    });
    expect(inheritedEdit.snapshot.sources["main.jsx"]).toContain('accent="#00ff00"');
    expect(inheritedEdit.snapshot.sources["main.jsx"]).not.toContain('fill="#00ff00"');
    expect(inheritedEdit.snapshot.sources["Card.jsx"]).toBe(component);
    expect(
      inheritedEdit.snapshot.compilation.ir.compositions[0]!.timeline.tracks[0]!.clips[0]!.content!
        .children[0]!.props.fill,
    ).toEqual({ kind: "color", value: "#00ff00" });

    const undone = await service.undo();
    expect(undone.sources["main.jsx"]).not.toContain("accent=");
    expect(undone.sources["main.jsx"]).toContain('text="World"');
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

  it("moves clips across tracks and supports slip, duplicate, link, unlink, and deletion", async () => {
    const { service } = await setup();
    const addedTrack = await service.execute({
      type: "track.add",
      sequenceId: "sequence_main",
      kind: "video",
      name: "B-roll",
    });
    const destinationTrackId = addedTrack.createdIds[0]! as `track_${string}`;
    const added = await service.execute({
      type: "clip.add",
      trackId: "track_video_1",
      audioTrackId: "track_audio_1",
      assetId: "asset_camera",
      timelineStartUs: timeUs(0),
      sourceEndUs: timeUs(2_000_000),
    });
    const [videoId, audioId] = added.createdIds as [`clip_${string}`, `clip_${string}`];
    const moved = await service.execute({
      type: "clip.move",
      clipId: videoId!,
      trackId: destinationTrackId,
      timelineStartUs: timeUs(1_000_000),
    });
    expect(
      moved.snapshot.compilation.ir.compositions[0]!.timeline.tracks.find(
        (track) => track.id === destinationTrackId,
      )!.clips[0],
    ).toMatchObject({ id: videoId, timelineStartUs: 1_000_000 });
    expect(moved.snapshot.sources["main.jsx"]).toContain("start={microseconds(1000000)}");

    await service.execute({ type: "clip.unlink", clipId: videoId! });
    await service.execute({ type: "clip.slip", clipId: videoId!, sourceStartUs: timeUs(500_000) });
    const duplicated = await service.execute({
      type: "clip.duplicate",
      clipId: videoId!,
      timelineStartUs: timeUs(4_000_000),
    });
    expect(duplicated.createdIds).toHaveLength(1);
    await service.execute({
      type: "clip.remove",
      clipId: duplicated.createdIds[0]! as `clip_${string}`,
    });

    await service.execute({
      type: "clip.move",
      clipId: audioId!,
      timelineStartUs: timeUs(1_000_000),
    });
    await service.execute({
      type: "clip.slip",
      clipId: audioId!,
      sourceStartUs: timeUs(500_000),
    });
    const linked = await service.execute({
      type: "clip.link",
      clipId: videoId!,
      linkedClipId: audioId!,
    });
    const clips = linked.snapshot.compilation.ir.compositions[0]!.timeline.tracks.flatMap(
      (track) => track.clips,
    );
    expect(clips.find((clip) => clip.id === videoId)?.linkedClipId).toBe(audioId);
    expect(clips.find((clip) => clip.id === audioId)?.linkedClipId).toBe(videoId);
  });

  it("creates, reorders, removes tracks, and removes a composition through valid source", async () => {
    const { service } = await setup();
    await service.execute({ type: "track.reorder", trackId: "track_overlay_1", index: 0 });
    await service.execute({ type: "track.remove", trackId: "track_overlay_1" });
    const created = await service.execute({
      type: "sequence.createFromAssets",
      assetIds: ["asset_camera"],
      name: "Selects",
    });
    const createdSequenceId = created.createdIds[0]!;
    expect(created.snapshot.compilation.ir.activeCompositionId).toBe(createdSequenceId);
    const removed = await service.execute({
      type: "sequence.remove",
      sequenceId: "sequence_main",
    });
    expect(removed.snapshot.compilation.ir.compositions.map(({ id }) => id)).toEqual([
      createdSequenceId,
    ]);
    expect(removed.snapshot.sources["main.jsx"]).not.toContain('id="sequence_main"');
  });

  it("persists project, asset, and timeline notes through one validated history", async () => {
    const { service } = await setup();
    const projectNote = await service.execute({
      type: "note.upsert",
      target: "project",
      note: { id: "note_intent", kind: "story-intent", text: "Open quietly" },
    });
    expect(projectNote.snapshot.manifest.notes).toEqual([
      { id: "note_intent", kind: "story-intent", text: "Open quietly" },
    ]);

    const assetNote = await service.execute({
      type: "note.upsert",
      target: "asset",
      assetId: "asset_camera",
      note: { id: "note_eyeline", kind: "continuity", text: "Watch the eyeline" },
    });
    expect(assetNote.snapshot.assets[0]?.notes).toEqual([
      { id: "note_eyeline", kind: "continuity", text: "Watch the eyeline" },
    ]);

    const timelineNote = await service.execute({
      type: "note.upsert",
      target: "timeline",
      sequenceId: "sequence_main",
      note: {
        id: "note_scene",
        kind: "scene",
        text: "Kitchen",
        atUs: timeUs(2_000_000),
        durationUs: timeUs(3_000_000),
      },
    });
    expect(timelineNote.snapshot.compilation.ir.compositions[0]?.timeline.notes).toEqual([
      expect.objectContaining({ id: "note_scene", atUs: 2_000_000, text: "Kitchen" }),
    ]);
    expect(timelineNote.snapshot.sources["main.jsx"]).toContain('<note id="note_scene"');

    const updated = await service.execute({
      type: "note.upsert",
      target: "timeline",
      sequenceId: "sequence_main",
      note: {
        id: "note_scene",
        kind: "edit-task",
        text: "Tighten the entrance",
        atUs: timeUs(2_500_000),
      },
    });
    expect(updated.snapshot.compilation.ir.compositions[0]?.timeline.notes[0]).toMatchObject({
      kind: "edit-task",
      text: "Tighten the entrance",
      atUs: 2_500_000,
    });
    const removed = await service.execute({
      type: "note.remove",
      target: "project",
      noteId: "note_intent",
    });
    expect(removed.snapshot.manifest.notes).toEqual([]);
    expect((await service.undo()).manifest.notes).toHaveLength(1);
  });
});

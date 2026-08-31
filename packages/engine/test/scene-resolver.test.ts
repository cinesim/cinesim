import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SETTINGS, timeUs } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import { applyCommand, createProject, projectToIr } from "../../core/test/project-fixtures";
import { irTimeUs } from "@cinesim/ir";
import type { IrSceneNode } from "@cinesim/ir";
import { resolveScene, resolveSceneFrame } from "../src/playback/scene-resolver";

const asset: Asset = {
  id: "asset_layer",
  kind: "video",
  name: "Layer.mov",
  source: { kind: "local", path: "/media/layer.mov" },
  durationUs: timeUs(1_000_000),
};

describe("timeline visual layer order", () => {
  it("resolves lower tracks first so index zero composites uppermost", () => {
    let project = applyCommand(createProject({ name: "Layers" }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "overlay",
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000001",
      assetId: asset.id,
      timelineStartUs: timeUs(0),
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: "track_000003",
      assetId: asset.id,
      timelineStartUs: timeUs(0),
    }).project;

    expect(
      resolveScene(
        { program: projectToIr(project, DEFAULT_SETTINGS), assets: project.assets },
        timeUs(500_000),
      ).map((layer) => layer.track.id),
    ).toEqual(["track_000001", "track_000003"]);
  });

  it("resolves generated grid media, graphics, effects, and title animation from IR", () => {
    let project = applyCommand(createProject({ name: "Generated scene" }), {
      type: "asset.import",
      asset,
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId: project.sequences[0]!.tracks[0]!.id,
      assetId: asset.id,
      timelineStartUs: timeUs(0),
    }).project;
    const assets = ["maya", "noah", "mina", "leo", "zara"].map((name): Asset => ({
      ...asset,
      id: `asset_${name}` as Asset["id"],
      name,
    }));
    const ir = projectToIr(project, DEFAULT_SETTINGS);
    const clip = ir.compositions[0]!.timeline.tracks[0]!.clips[0]!;
    delete clip.assetId;
    delete clip.mediaKind;
    ir.referencedAssetIds = assets.map((candidate) => candidate.id);
    const visualDefaults = {
      x: { kind: "length" as const, unit: "px" as const, value: 0 },
      y: { kind: "length" as const, unit: "px" as const, value: 0 },
      opacity: { kind: "number" as const, value: 1 },
      scale: { kind: "number" as const, value: 1 },
      scaleX: { kind: "number" as const, value: 1 },
      scaleY: { kind: "number" as const, value: 1 },
    };
    const content: IrSceneNode = {
      id: "scene",
      kind: "group",
      props: visualDefaults,
      animations: [],
      effects: [
        {
          id: "grade",
          kind: "colorgrade",
          enabled: true,
          props: {
            exposure: { kind: "number", value: 0.1 },
            saturation: { kind: "number", value: 1.2 },
          },
          children: [],
        },
      ],
      children: [
        {
          id: "background",
          kind: "rect",
          props: {
            ...visualDefaults,
            width: { kind: "length", unit: "px", value: 1920 },
            height: { kind: "length", unit: "px", value: 1080 },
            fill: { kind: "color", value: "#070914" },
          },
          animations: [],
          effects: [],
          children: [],
        },
        {
          id: "speakers",
          kind: "grid",
          props: {
            ...visualDefaults,
            x: { kind: "length", unit: "px", value: 72 },
            y: { kind: "length", unit: "px", value: 72 },
            width: { kind: "length", unit: "px", value: 1776 },
            height: { kind: "length", unit: "px", value: 850 },
            columns: { kind: "number", value: 3 },
            rows: { kind: "number", value: 2 },
            gap: { kind: "length", unit: "px", value: 20 },
          },
          animations: [],
          effects: [],
          children: assets.map((candidate): IrSceneNode => ({
            id: candidate.name,
            kind: "video",
            props: {
              ...visualDefaults,
              source: { kind: "resource", assetId: candidate.id },
              fit: { kind: "string", value: "cover" },
              radius: { kind: "length", unit: "px", value: 24 },
            },
            animations: [],
            effects: [],
            children: [],
          })),
        },
        {
          id: "title",
          kind: "group",
          props: {
            ...visualDefaults,
            x: { kind: "length", unit: "px", value: 96 },
            y: { kind: "length", unit: "px", value: 880 },
            opacity: { kind: "number", value: 0 },
          },
          animations: [
            {
              property: "opacity",
              keyframes: [
                { at: irTimeUs(0), value: { kind: "number", value: 0 }, easing: "linear" },
                {
                  at: irTimeUs(1_000_000),
                  value: { kind: "number", value: 1 },
                  easing: "linear",
                },
              ],
            },
          ],
          effects: [],
          children: [
            {
              id: "panel",
              kind: "rect",
              props: {
                ...visualDefaults,
                width: { kind: "length", unit: "px", value: 720 },
                height: { kind: "length", unit: "px", value: 142 },
                fill: { kind: "color", value: "#12162a" },
                radius: { kind: "length", unit: "px", value: 28 },
              },
              animations: [],
              effects: [],
              children: [],
            },
            {
              id: "name",
              kind: "text",
              props: {
                ...visualDefaults,
                x: { kind: "length", unit: "px", value: 54 },
                y: { kind: "length", unit: "px", value: 28 },
                text: { kind: "string", value: "Maya" },
                fontSize: { kind: "length", unit: "px", value: 42 },
                color: { kind: "color", value: "#ffffff" },
              },
              animations: [],
              effects: [],
              children: [],
            },
          ],
        },
      ],
    };
    clip.content = content;

    const resolved = resolveSceneFrame({ program: ir, assets }, timeUs(500_000));
    expect(resolved.media).toHaveLength(5);
    expect(resolved.media.map((layer) => layer.asset.id)).toEqual(
      assets.map((candidate) => candidate.id),
    );
    expect(resolved.media[0]!.transform).toMatchObject({
      x: expect.closeTo(-0.623_6, 3),
      scaleX: expect.closeTo(0.301_4, 3),
      fit: "cover",
    });
    expect(resolved.media[0]!.cornerRadiusPx).toBe(24);
    expect(resolved.graphics.find((graphic) => graphic.nodeId === "background")?.order).toBe(0);
    expect(resolved.media[0]!.order).toBe(1);
    expect(resolved.media[0]!.colorAdjustment).toMatchObject({
      exposure: 0.1,
      saturation: 1.2,
    });
    expect(resolved.graphics.find((graphic) => graphic.nodeId === "panel")?.transform.opacity).toBe(
      0.5,
    );
    expect(resolved.graphics.filter((graphic) => graphic.kind === "glyph")).toHaveLength(4);
  });
});

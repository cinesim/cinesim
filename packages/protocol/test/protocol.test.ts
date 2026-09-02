import { describe, expect, it } from "vite-plus/test";
import { editorCommandSchema } from "../src";

describe("editor command protocol", () => {
  it("validates track commands and rejects empty updates", () => {
    expect(
      editorCommandSchema.parse({
        type: "track.add",
        sequenceId: "sequence_main",
        kind: "overlay",
        name: "Titles",
      }),
    ).toMatchObject({ type: "track.add", name: "Titles" });
    expect(() =>
      editorCommandSchema.parse({ type: "track.update", trackId: "track_000001" }),
    ).toThrow();
  });

  it("rejects malformed IDs, times, and collection edits", () => {
    expect(() =>
      editorCommandSchema.parse({
        type: "clip.move",
        clipId: "third clip",
        timelineStartUs: 1.5,
      }),
    ).toThrow();
    expect(() =>
      editorCommandSchema.parse({ type: "sequence.createFromAssets", assetIds: [] }),
    ).toThrow();
    expect(() =>
      editorCommandSchema.parse({ type: "asset.remove", assetIds: ["not-an-asset"] }),
    ).toThrow();
  });

  it("validates nonempty, positive sequence range edits", () => {
    expect(() =>
      editorCommandSchema.parse({
        type: "sequence.deleteRanges",
        sequenceId: "sequence_main",
        ranges: [],
        mode: "ripple",
      }),
    ).toThrow();
    expect(() =>
      editorCommandSchema.parse({
        type: "sequence.deleteRanges",
        sequenceId: "sequence_main",
        ranges: [{ startUs: 20, endUs: 10 }],
        mode: "lift",
      }),
    ).toThrow();
  });

  it("validates typed properties and extended clip commands", () => {
    expect(
      editorCommandSchema.parse({
        type: "property.set",
        nodeId: "title:root",
        property: "opacity",
        value: { kind: "number", value: 0.5 },
        scope: "instance",
      }),
    ).toMatchObject({ type: "property.set", property: "opacity" });
    expect(
      editorCommandSchema.parse({
        type: "property.setMany",
        nodeId: "clip_000001",
        updates: [
          { property: "x", value: { kind: "length", unit: "px", value: 120 } },
          { property: "y", value: { kind: "length", unit: "px", value: -40 } },
        ],
        scope: "instance",
      }),
    ).toMatchObject({ type: "property.setMany", updates: [{ property: "x" }, { property: "y" }] });
    expect(() =>
      editorCommandSchema.parse({
        type: "property.setMany",
        nodeId: "clip_000001",
        updates: [
          { property: "x", value: { kind: "length", unit: "px", value: 1 } },
          { property: "x", value: { kind: "length", unit: "px", value: 2 } },
        ],
      }),
    ).toThrow();
    expect(
      editorCommandSchema.parse({
        type: "clip.slip",
        clipId: "clip_000001",
        sourceStartUs: 500_000,
      }),
    ).toMatchObject({ type: "clip.slip" });
    expect(() =>
      editorCommandSchema.parse({
        type: "property.set",
        nodeId: "title:root",
        property: "opacity",
        value: { kind: "number", value: Number.NaN },
      }),
    ).toThrow();
  });

  it("validates complete typed keyframe gestures", () => {
    expect(
      editorCommandSchema.parse({
        type: "keyframe.add",
        nodeId: "title:root",
        property: "opacity",
        atUs: 500_000,
        value: { kind: "number", value: 0.5 },
        easing: "ease-in-out",
      }),
    ).toMatchObject({ type: "keyframe.add", easing: "ease-in-out" });
    expect(
      editorCommandSchema.parse({
        type: "keyframe.remove",
        nodeId: "title:root",
        property: "opacity",
        index: 1,
      }),
    ).toMatchObject({ type: "keyframe.remove", index: 1 });
    expect(() =>
      editorCommandSchema.parse({
        type: "keyframe.set",
        nodeId: "title:root",
        property: "opacity",
        index: 0,
        easing: "spring",
      }),
    ).toThrow();
  });
});

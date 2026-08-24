import { describe, expect, it } from "vitest";
import { createProject } from "@cinesim/core";
import { dispatchCommand } from "../src";

describe("protocol command dispatch", () => {
  it("validates and dispatches track commands", () => {
    const project = createProject({ name: "Protocol" });
    const added = dispatchCommand(project, {
      type: "track.add",
      sequenceId: project.activeSequenceId,
      kind: "overlay",
      name: " Titles ",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.project.sequences[0]!.tracks[2]).toMatchObject({
      id: "track_000003",
      name: "Titles",
      kind: "overlay",
    });

    const reordered = dispatchCommand(added.value.project, {
      type: "track.reorder",
      trackId: "track_000003",
      index: 0,
    });
    expect(reordered.ok).toBe(true);
  });

  it("rejects empty track updates at the protocol boundary", () => {
    const result = dispatchCommand(createProject({ name: "Protocol" }), {
      type: "track.update",
      trackId: "track_000001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_COMMAND");
  });

  it("serializes malformed command errors", () => {
    const result = dispatchCommand(createProject({ name: "Protocol" }), {
      type: "clip.move",
      clipId: "third clip",
      timelineStartUs: 1.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_COMMAND");
  });

  it("uses core command errors for valid requests", () => {
    const result = dispatchCommand(createProject({ name: "Protocol" }), {
      type: "clip.remove",
      clipId: "clip_000001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not found/);
  });
});

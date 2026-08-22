import { describe, expect, it } from "vitest";
import { createProject } from "@cinesim/core";
import { dispatchCommand } from "../src";

describe("protocol command dispatch", () => {
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

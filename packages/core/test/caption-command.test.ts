import { irTimeUs, type IrCaptionTrack } from "@cinesim/ir";
import { describe, expect, it } from "vite-plus/test";
import { planSemanticCommand } from "../src";
import { createProject, projectToIr } from "./project-fixtures";

function captionTrack(text = "Hello world"): IrCaptionTrack {
  return {
    id: "captiontrack_generated",
    name: "Generated captions",
    transcriptFingerprint: "transcript-v1-abc123",
    props: { fill: { kind: "color", value: "#ffffff" } },
    cues: [
      {
        id: "cue_hello",
        startUs: irTimeUs(1_000_000),
        durationUs: irTimeUs(750_000),
        text,
        props: {},
        animations: [],
        words: [
          {
            id: "captionword_hello",
            startUs: irTimeUs(0),
            durationUs: irTimeUs(350_000),
            text: "Hello",
          },
        ],
      },
    ],
  };
}

describe("caption generation command", () => {
  it("inserts or regenerates a complete caption track with one structural patch", () => {
    const project = createProject({ name: "Captions" });
    const program = projectToIr(project);
    const sequenceId = project.activeSequenceId;
    const inserted = planSemanticCommand(program, [], {
      type: "caption.generate",
      sequenceId,
      track: captionTrack(),
    });
    expect(inserted.patches).toEqual([
      expect.objectContaining({ type: "node.insert", parentId: "timeline_000001" }),
    ]);
    expect(inserted.program.compositions[0]!.timeline.captionTracks[0]?.cues[0]?.text).toBe(
      "Hello world",
    );

    const replaced = planSemanticCommand(inserted.program, [], {
      type: "caption.generate",
      sequenceId,
      track: captionTrack("Updated text"),
    });
    expect(replaced.patches).toEqual([
      expect.objectContaining({ type: "node.replace", nodeId: "captiontrack_generated" }),
    ]);
    expect(replaced.program.compositions[0]!.timeline.captionTracks).toHaveLength(1);
    expect(replaced.program.compositions[0]!.timeline.captionTracks[0]?.cues[0]?.text).toBe(
      "Updated text",
    );
  });
});

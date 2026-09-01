import { irTimeUs } from "@cinesim/ir";
import { describe, expect, it } from "vite-plus/test";
import { planSemanticCommand, timeUs, type Asset, type ClipId } from "../src";
import { applyCommand, createProject, projectToIr } from "./project-fixtures";

const asset: Asset = {
  id: "asset_transition",
  kind: "video",
  name: "Transition source",
  source: { kind: "local", path: "/media/transition.mov" },
  durationUs: timeUs(5_000_000),
};

describe("transition command integration", () => {
  it("removes a transition atomically when a clip edit invalidates its edit point", () => {
    let project = applyCommand(createProject({ name: "Transition command" }), {
      type: "asset.import",
      asset,
    }).project;
    const trackId = project.sequences[0]!.tracks[0]!.id;
    project = applyCommand(project, {
      type: "clip.add",
      trackId,
      assetId: asset.id,
      timelineStartUs: timeUs(0),
      sourceStartUs: timeUs(0),
      sourceEndUs: timeUs(2_000_000),
    }).project;
    project = applyCommand(project, {
      type: "clip.add",
      trackId,
      assetId: asset.id,
      timelineStartUs: timeUs(2_000_000),
      sourceStartUs: timeUs(1_000_000),
      sourceEndUs: timeUs(3_000_000),
    }).project;
    const program = projectToIr(project);
    const [from, to] = program.compositions[0]!.timeline.tracks[0]!.clips;
    program.compositions[0]!.timeline.transitions.push({
      id: "transition_edit",
      fromClipId: from!.id,
      toClipId: to!.id,
      kind: "dissolve",
      durationUs: irTimeUs(500_000),
      easing: "linear",
      props: {},
    });

    const plan = planSemanticCommand(program, project.assets, {
      type: "clip.move",
      clipId: to!.id as ClipId,
      timelineStartUs: timeUs(3_000_000),
    });
    expect(plan.program.compositions[0]!.timeline.transitions).toEqual([]);
    expect(plan.patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "property.set", nodeId: to!.id, property: "start" }),
        { type: "node.remove", nodeId: "transition_edit" },
      ]),
    );
    expect(plan.changedIds).toContain("transition_edit");
  });
});

import { describe, expect, it } from "vite-plus/test";
import type { PropertySchema } from "@cinesim/compiler";
import {
  inspectorPropertyLabel,
  matchesInspectorQuery,
  propertyMatchesQuery,
} from "../src/renderer/components/workspace/inspector-model";

const positionX: PropertySchema = {
  name: "x",
  type: "length",
  label: "X",
  group: "transform",
  control: "number",
  required: false,
  animatable: true,
  step: 1,
};

describe("inspector property model", () => {
  it("finds properties by label, source name, group, and editor-friendly aliases", () => {
    expect(propertyMatchesQuery(positionX, "position")).toBe(true);
    expect(propertyMatchesQuery(positionX, "transform")).toBe(true);
    expect(propertyMatchesQuery(positionX, "opacity")).toBe(false);
  });

  it("uses contextual labels for terse source properties", () => {
    expect(inspectorPropertyLabel(positionX)).toBe("Position X");
  });

  it("treats an empty property search as matching", () => {
    expect(matchesInspectorQuery("", "Timing")).toBe(true);
    expect(matchesInspectorQuery("frame", "Frame rate")).toBe(true);
  });
});

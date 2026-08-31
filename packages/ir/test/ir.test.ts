import { describe, expect, it } from "vite-plus/test";
import { evaluateIrFrame, serializeIr, type IrDocument, type SourceSpan } from "@cinesim/ir";

const span: SourceSpan = {
  uri: "memory:///main.jsx",
  revision: "one",
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 2, offset: 1 },
};

function document(): IrDocument {
  const edit = {
    expected: "number" as const,
    source: span,
    strategy: "replace-expression" as const,
  };
  return {
    version: 1,
    entry: span.uri,
    sources: [{ uri: span.uri, revision: span.revision }],
    root: {
      id: "root",
      kind: "composition",
      origin: span,
      componentStack: [],
      props: { opacity: { value: { kind: "number", value: 0 }, edit } },
      animations: [
        {
          property: "opacity",
          origin: span,
          keyframes: [
            {
              at: { kind: "time", valueUs: 0 },
              value: { kind: "number", value: 0 },
              easing: "linear",
              origin: span,
              edits: {
                at: { ...edit, expected: "time" },
                value: edit,
              },
            },
            {
              at: { kind: "time", valueUs: 1_000_000 },
              value: { kind: "number", value: 1 },
              easing: "linear",
              origin: span,
              edits: {
                at: { ...edit, expected: "time" },
                value: edit,
              },
            },
          ],
        },
      ],
      children: [],
    },
  };
}

describe("ir", () => {
  it("serializes with deterministic key ordering", () => {
    expect(serializeIr({ z: 1, a: { d: 2, b: 1 } })).toBe(
      '{\n  "a": {\n    "b": 1,\n    "d": 2\n  },\n  "z": 1\n}\n',
    );
  });

  it("evaluates numeric keyframes", () => {
    expect(evaluateIrFrame(document(), 500_000).props.opacity).toEqual({
      kind: "number",
      value: 0.5,
    });
  });
});

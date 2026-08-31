import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  compileVideo,
  parseCompilerConfig,
  rewriteSourceValue,
  type CompilerConfig,
  type CompilerHost,
} from "@cinesim/compiler";

const config: CompilerConfig = {
  version: 1,
  entry: "main.jsx",
  output: ".context/compiler",
  sourceMaps: true,
  strict: true,
};

function host(files: Record<string, string>): CompilerHost {
  return {
    async read(uri) {
      const source = files[uri];
      if (source === undefined) throw new Error(`Missing test module ${uri}.`);
      return { source, revision: `${uri}-revision` };
    },
    async resolve(specifier, importer) {
      return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    },
  };
}

describe("compiler", () => {
  it("expands imported components and retains both definition and invocation origins", async () => {
    const files = {
      "main.jsx": `
        import { Card } from "./Card.jsx";
        export default <composition id="scene" width={1920} height={1080} frameRate={30} duration={seconds(2)}><Card id="title" text="Hello" /></composition>;
      `,
      "Card.jsx": `
        export function Card({ text }) {
          return <group id="root" opacity={0}><text id="label" text={text} color="#fff" fontSize={px(40)} /></group>;
        }
      `,
    };

    const result = await compileVideo("main.jsx", config, host(files));
    const card = result.ir.root.children[0]!;
    expect(card.id).toBe("title/root");
    expect(card.children[0]!.id).toBe("title/label");
    expect(card.componentStack).toHaveLength(1);
    expect(card.componentStack[0]!.definition.uri).toBe("Card.jsx");
    expect(card.componentStack[0]!.invocation.uri).toBe("main.jsx");
    expect(result.sourceMap.nodes["title/label"]?.properties.text?.source.uri).toBe("main.jsx");

    const opacity = card.props.opacity!;
    expect(
      rewriteSourceValue({
        source: files["Card.jsx"],
        revision: "Card.jsx-revision",
        target: opacity.edit,
        value: { kind: "number", value: 1 },
      }),
    ).toContain("opacity={1}");
  });

  it("rejects stale source rewrites", async () => {
    const source = `export default <composition id="scene" width={1} height={1} frameRate={30} duration={seconds(1)} />;`;
    const result = await compileVideo("main.jsx", config, host({ "main.jsx": source }));
    expect(() =>
      rewriteSourceValue({
        source,
        revision: "newer-revision",
        target: result.ir.root.props.width!.edit,
        value: { kind: "number", value: 2 },
      }),
    ).toThrow(/stale edit/);
  });

  it("rejects arbitrary JavaScript execution", async () => {
    const source = `export default <composition id="scene" width={readSecret()} height={1} frameRate={30} duration={seconds(1)} />;`;
    await expect(
      compileVideo("main.jsx", config, host({ "main.jsx": source })),
    ).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ code: "UNKNOWN_HELPER" }),
    });
  });

  it("parses the stable TOML-facing configuration shape", () => {
    expect(
      parseCompilerConfig({
        version: 1,
        entry: "main.jsx",
        output: ".context/out",
        source_maps: false,
        strict: true,
      }),
    ).toEqual({
      version: 1,
      entry: "main.jsx",
      output: ".context/out",
      sourceMaps: false,
      strict: true,
    });
  });
});

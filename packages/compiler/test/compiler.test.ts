import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  compileVideo,
  DEFAULT_COMPILER_BUDGETS,
  parseCompilerConfig,
  rewriteSourceValue,
  type CompilerConfig,
  type CompilerHost,
} from "@cinesim/compiler";

const config: CompilerConfig = {
  languageVersion: 1,
  projectId: "project_test",
  activeCompositionId: "sequence_main",
  entry: "main.jsx",
  output: ".video/compiler",
  sourceMaps: true,
  strict: true,
  assetIds: ["asset_camera"],
  budgets: DEFAULT_COMPILER_BUDGETS,
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

const wrapper = (content: string): string =>
  `export const main = <composition id="sequence_main" width={1920} height={1080} fps={30}><timeline id="timeline_main"><track id="track_overlay" kind="overlay" name="Overlay"><clip id="clip_scene" start={seconds(0)} duration={seconds(2)}>${content}</clip></track></timeline></composition>; export default main;`;

describe("compiler", () => {
  it("lowers explicit timelines and imported components with call-site provenance", async () => {
    const files = {
      "main.jsx": `import { Card } from "./Card.jsx"; ${wrapper('<Card id="title" text="Hello" />')}`,
      "Card.jsx": `export function Card({ text, opacity = 0 }) { return <group id="root" opacity={opacity}><text id="label" text={text} color="#fff" fontSize={px(40)} /></group>; }`,
    };
    const result = await compileVideo("main.jsx", config, host(files));
    const clip = result.ir.compositions[0]!.timeline.tracks[0]!.clips[0]!;
    expect(clip.content?.id).toBe("title/root");
    expect(clip.content?.children[0]!.id).toBe("title/label");
    expect(result.sourceMap.nodes["title/label"]?.properties.text?.writeSpan?.uri).toBe("main.jsx");
    const opacity = result.sourceMap.nodes["title/root"]!.properties.opacity!;
    expect(opacity.kind).toBe("default");
    expect(opacity.insertion?.source.uri).toBe("main.jsx");
  });

  it("rewrites direct typed values and rejects stale revisions", async () => {
    const source = wrapper('<rect id="panel" width={px(10)} height={px(20)} />');
    const result = await compileVideo("main.jsx", config, host({ "main.jsx": source }));
    const target = result.sourceMap.nodes.panel!.properties.width!;
    expect(
      rewriteSourceValue({
        source,
        revision: "main.jsx-revision",
        target: {
          expected: target.value.kind,
          source: target.writeSpan!,
          strategy: target.strategy,
        },
        value: { kind: "length", unit: "px", value: 50 },
      }),
    ).toContain("width={px(50)}");
    expect(() =>
      rewriteSourceValue({
        source,
        revision: "newer",
        target: {
          expected: target.value.kind,
          source: target.writeSpan!,
          strategy: target.strategy,
        },
        value: { kind: "length", unit: "px", value: 50 },
      }),
    ).toThrow(/stale edit/);
  });

  it("validates asset ids and rejects arbitrary JavaScript execution", async () => {
    await expect(
      compileVideo(
        "main.jsx",
        config,
        host({ "main.jsx": wrapper('<video id="camera" source={asset("asset_missing")} />') }),
      ),
    ).rejects.toMatchObject({ diagnostic: expect.objectContaining({ code: "UNKNOWN_ASSET" }) });
    await expect(
      compileVideo(
        "main.jsx",
        config,
        host({ "main.jsx": wrapper('<rect id="panel" width={readSecret()} />') }),
      ),
    ).rejects.toMatchObject({ diagnostic: expect.objectContaining({ code: "UNKNOWN_HELPER" }) });
  });

  it("collects multiple compositions and parses the project manifest boundary", async () => {
    const source = `export const main = <composition id="sequence_main" width={1920} height={1080} fps={30}><timeline id="timeline_main" /></composition>; export const selects = <composition id="sequence_selects" width={1280} height={720} fps={24}><timeline id="timeline_selects" /></composition>; export default main;`;
    const result = await compileVideo("main.jsx", config, host({ "main.jsx": source }));
    expect(result.ir.compositions.map((composition) => composition.id)).toEqual([
      "sequence_main",
      "sequence_selects",
    ]);
    expect(
      parseCompilerConfig(
        {
          format_version: 3,
          language_version: 1,
          project: {
            id: "project_test",
            name: "Test",
            entry: "main.jsx",
            active_composition: "sequence_main",
          },
          compiler: { strict: true },
        },
        ["asset_camera"],
      ),
    ).toMatchObject({
      projectId: "project_test",
      entry: "main.jsx",
      assetIds: ["asset_camera"],
      output: ".video/compiler",
    });
  });

  it("lowers structured non-rendering timeline notes", async () => {
    const source = `export const main = <composition id="sequence_main" width={1920} height={1080} fps={30}><timeline id="timeline_main"><note id="note_scene" at={seconds(2)} duration={seconds(3)} kind="scene" text="Move into the kitchen" /></timeline></composition>; export default main;`;
    const result = await compileVideo("main.jsx", config, host({ "main.jsx": source }));
    expect(result.ir.compositions[0]?.timeline.notes).toEqual([
      {
        id: "note_scene",
        atUs: 2_000_000,
        durationUs: 3_000_000,
        kind: "scene",
        text: "Move into the kitchen",
      },
    ]);
    expect(result.sourceMap.nodes.note_scene?.structural.nodeKind).toBe("note");
  });

  it("enforces component depth and source budgets", async () => {
    const tiny = { ...config, budgets: { ...config.budgets, maxSourceBytes: 10 } };
    await expect(
      compileVideo("main.jsx", tiny, host({ "main.jsx": wrapper("") })),
    ).rejects.toMatchObject({ diagnostic: expect.objectContaining({ code: "SOURCE_BUDGET" }) });
  });

  it("loads the complete static import graph and rejects cycles even when imports are unused", async () => {
    const entry = `import { Extra } from "./Extra.jsx"; ${wrapper("")}`;
    const result = await compileVideo(
      "main.jsx",
      config,
      host({
        "main.jsx": entry,
        "Extra.jsx": 'export function Extra() { return <rect id="extra" />; }',
      }),
    );
    expect(result.modules.map((module) => module.uri)).toEqual(["Extra.jsx", "main.jsx"]);

    await expect(
      compileVideo(
        "main.jsx",
        config,
        host({
          "main.jsx": entry,
          "Extra.jsx":
            'import { Cycle } from "./Cycle.jsx"; export function Extra() { return <rect id="extra" />; }',
          "Cycle.jsx":
            'import { Extra } from "./Extra.jsx"; export function Cycle() { return <rect id="cycle" />; }',
        }),
      ),
    ).rejects.toMatchObject({ diagnostic: expect.objectContaining({ code: "IMPORT_CYCLE" }) });
  });
});

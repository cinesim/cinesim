import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  compileVideo,
  DEFAULT_COMPILER_BUDGETS,
  parseCompilerConfig,
  printNodeTemplate,
  rewriteSourceValue,
  type CompilerConfig,
  type CompilerHost,
} from "@cinesim/compiler";
import { irTimeUs } from "@cinesim/ir";

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

  it("lowers deterministic audio ducking against a separate sidechain track", async () => {
    const source = `export const main = <composition id="sequence_main" width={1920} height={1080} fps={30}><timeline id="timeline_main"><track id="track_music" kind="audio" name="Music"><clip id="clip_music" asset={asset("asset_camera")} media="audio" start={seconds(0)} duration={seconds(10)}><ducker id="duck_music" sidechain="track_dialogue" reduction={db(-12)} attack={milliseconds(80)} release={milliseconds(250)} /></clip></track><track id="track_dialogue" kind="audio" name="Dialogue"><clip id="clip_dialogue" asset={asset("asset_camera")} media="audio" start={seconds(2)} duration={seconds(3)} /></track></timeline></composition>; export default main;`;
    const result = await compileVideo("main.jsx", config, host({ "main.jsx": source }));

    expect(result.ir.compositions[0]!.timeline.tracks[0]!.clips[0]!.effects[0]).toMatchObject({
      id: "duck_music",
      kind: "ducker",
      props: {
        sidechain: { kind: "string", value: "track_dialogue" },
        reduction: { kind: "decibels", value: -12 },
        attack: { kind: "time", valueUs: 80_000 },
        release: { kind: "time", valueUs: 250_000 },
      },
    });
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

  it("lowers dedicated editable caption tracks, cues, words, and typed animation", async () => {
    const source = `export const main = <composition id="sequence_main" width={1920} height={1080} fps={30}><timeline id="timeline_main"><captiontrack id="captions_en" name="English" transcriptFingerprint="sha256:fixture" language="en" fontSize={px(64)} placement="bottom"><cue id="cue_intro" start={seconds(1)} duration={seconds(2)} text="Welcome home" speaker="HOST" scale={1}><captionword id="word_welcome" start={seconds(0)} duration={milliseconds(800)} text="Welcome" /><captionword id="word_home" start={milliseconds(800)} duration={milliseconds(700)} text="home" /><animate property="scale"><key at={seconds(0)} value={0.9} easing="ease-out" /><key at={milliseconds(150)} value={1} easing="ease-out" /></animate></cue></captiontrack></timeline></composition>; export default main;`;
    const result = await compileVideo("main.jsx", config, host({ "main.jsx": source }));

    expect(result.ir.compositions[0]!.timeline.captionTracks).toMatchObject([
      {
        id: "captions_en",
        name: "English",
        transcriptFingerprint: "sha256:fixture",
        language: "en",
        props: { fontSize: { kind: "length", unit: "px", value: 64 } },
        cues: [
          {
            id: "cue_intro",
            startUs: 1_000_000,
            durationUs: 2_000_000,
            text: "Welcome home",
            speaker: "HOST",
            words: [
              { id: "word_welcome", startUs: 0, durationUs: 800_000, text: "Welcome" },
              { id: "word_home", startUs: 800_000, durationUs: 700_000, text: "home" },
            ],
            animations: [
              {
                property: "scale",
                keyframes: [
                  { at: 0, value: { kind: "number", value: 0.9 }, easing: "ease-out" },
                  { at: 150_000, value: { kind: "number", value: 1 }, easing: "ease-out" },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(result.sourceMap.nodes.cue_intro?.structural.nodeKind).toBe("cue");
  });

  it("compiles expressive caption presets into ordinary typed animation", async () => {
    const source = `export const main = <composition id="sequence_main" width={1920} height={1080} fps={30}><timeline id="timeline_main"><captiontrack id="captions_en" name="English" animationPreset="word-emphasis"><cue id="cue_intro" start={seconds(1)} duration={seconds(2)} text="Welcome home"><captionword id="word_welcome" start={seconds(0)} duration={milliseconds(800)} text="Welcome" /><captionword id="word_home" start={milliseconds(800)} duration={milliseconds(700)} text="home" /></cue></captiontrack></timeline></composition>; export default main;`;
    const result = await compileVideo("main.jsx", config, host({ "main.jsx": source }));

    expect(result.ir.compositions[0]!.timeline.captionTracks[0]!.cues[0]!.animations).toEqual([
      {
        property: "wordProgress",
        keyframes: [
          { at: 0, value: { kind: "number", value: 0 }, easing: "hold" },
          { at: 800_000, value: { kind: "number", value: 1 }, easing: "hold" },
          { at: 1_500_000, value: { kind: "number", value: -1 }, easing: "hold" },
        ],
      },
    ]);
  });

  it("prints generated caption tracks as canonical editable JSX", () => {
    const source = printNodeTemplate({
      kind: "captiontrack",
      track: {
        id: "captiontrack_generated",
        name: "Generated captions",
        transcriptFingerprint: "transcript-v1-source",
        props: { fill: { kind: "color", value: "#ffffff" } },
        cues: [
          {
            id: "cue_generated",
            startUs: irTimeUs(1_000_000),
            durationUs: irTimeUs(800_000),
            text: "Hello",
            props: {},
            animations: [],
            words: [
              {
                id: "captionword_generated",
                startUs: irTimeUs(0),
                durationUs: irTimeUs(800_000),
                text: "Hello",
              },
            ],
          },
        ],
      },
    });

    expect(source).toContain('<captiontrack id="captiontrack_generated"');
    expect(source).toContain('transcriptFingerprint="transcript-v1-source"');
    expect(source).toContain('<captionword id="captionword_generated"');
  });

  it("lowers visual transitions and independent audio crossfades with typed parameters", async () => {
    const source = `export const main = <composition id="sequence_main" width={1920} height={1080} fps={30}><timeline id="timeline_main"><track id="track_video" kind="video" name="Video"><clip id="clip_from" asset={asset("asset_camera")} media="video" start={seconds(0)} in={seconds(0)} duration={seconds(3)} /><clip id="clip_to" asset={asset("asset_camera")} media="video" start={seconds(3)} in={seconds(2)} duration={seconds(3)} /></track><track id="track_audio" kind="audio" name="Audio"><clip id="clip_audio_from" asset={asset("asset_camera")} media="audio" start={seconds(0)} in={seconds(0)} duration={seconds(3)} /><clip id="clip_audio_to" asset={asset("asset_camera")} media="audio" start={seconds(3)} in={seconds(2)} duration={seconds(3)} /></track><transition id="transition_picture" from="clip_from" to="clip_to" kind="wipe" duration={seconds(1)} easing="ease-out" direction="left" softness={percent(3)} /><audiocrossfade id="transition_audio" from="clip_audio_from" to="clip_audio_to" duration={seconds(1)} curve="equal-power" /></timeline></composition>; export default main;`;
    const result = await compileVideo("main.jsx", config, host({ "main.jsx": source }));
    const timeline = result.ir.compositions[0]!.timeline;

    expect(timeline.transitions).toEqual([
      expect.objectContaining({
        id: "transition_picture",
        kind: "wipe",
        durationUs: 1_000_000,
        easing: "ease-out",
        props: expect.objectContaining({
          direction: { kind: "string", value: "left" },
          softness: { kind: "percent", value: 3 },
        }),
      }),
    ]);
    expect(timeline.audioTransitions).toEqual([
      {
        id: "transition_audio",
        fromClipId: "clip_audio_from",
        toClipId: "clip_audio_to",
        durationUs: 1_000_000,
        easing: "linear",
        curve: "equal-power",
      },
    ]);
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

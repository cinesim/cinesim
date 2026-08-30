import { describe, expect, it } from "vite-plus/test";
import { timeUs } from "@cinesim/core";
import type { ViewerController } from "../src/renderer/components/viewer/use-viewer-runtime";
import { EditorTransportController } from "../src/renderer/components/workspace/editor-transport";

function transportHarness(seekTimeline: ViewerController["seekTimeline"] = async () => undefined) {
  const calls: string[] = [];
  let playing = false;
  const controller: ViewerController = {
    seekTimeline: async (value) => {
      calls.push(`seek:${value}`);
      await seekTimeline(value);
    },
    enterAssetPreview: (assetId, value) => calls.push(`preview:${assetId}:${value}`),
    exitAssetPreview: async () => {
      calls.push("exit-preview");
    },
    playTimeline: () => calls.push("play"),
    pauseTimeline: () => calls.push("pause"),
    shuttle: (direction) => calls.push(`shuttle:${direction}`),
    stepFrames: async (frames) => {
      calls.push(`step:${frames}`);
    },
  };
  const transport = new EditorTransportController({
    isPlaying: () => playing,
    setPlayheadUs: (value) => calls.push(`playhead:${value}`),
  });
  transport.registerController(controller);
  return { calls, controller, transport, setPlaying: (value: boolean) => (playing = value) };
}

describe("editor transport", () => {
  it("routes timeline and preview actions through the registered viewer", async () => {
    const { calls, transport, setPlaying } = transportHarness();

    await transport.seekTimeline(timeUs(2_000_000));
    transport.togglePlayback();
    setPlaying(true);
    transport.togglePlayback();
    transport.shuttle(-1);
    await transport.stepFrames(1);
    transport.previewAsset("asset_test", timeUs(500_000));
    await transport.exitAssetPreview();

    expect(calls).toEqual([
      "playhead:2000000",
      "seek:2000000",
      "play",
      "pause",
      "shuttle:-1",
      "step:1",
      "preview:asset_test:500000",
      "exit-preview",
    ]);
  });

  it("plays a selected range and stops at its end", async () => {
    const { calls, transport } = transportHarness();

    await transport.playRange(timeUs(2_000_000), timeUs(4_000_000));
    transport.observePlayback(timeUs(3_999_999), true);
    transport.observePlayback(timeUs(4_000_000), true);

    expect(calls).toEqual(["playhead:2000000", "seek:2000000", "play", "pause"]);
  });

  it("does not start a range after another transport action supersedes its seek", async () => {
    let releaseSeek: () => void = () => undefined;
    const seek = new Promise<void>((resolve) => {
      releaseSeek = resolve;
    });
    const { calls, transport } = transportHarness(() => seek);

    const range = transport.playRange(timeUs(2_000_000), timeUs(4_000_000));
    transport.previewAsset("asset_test", timeUs(500_000));
    releaseSeek();
    await range;

    expect(calls).toEqual(["playhead:2000000", "seek:2000000", "preview:asset_test:500000"]);
  });
});

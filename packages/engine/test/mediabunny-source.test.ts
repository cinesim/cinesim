import type {
  AudioBufferSink,
  Input,
  InputVideoTrack,
  UrlSource,
  VideoSampleSink,
} from "mediabunny";
import { describe, expect, it } from "vite-plus/test";
import { MediabunnyWebCodecsSource } from "../src";

function videoTrack(): InputVideoTrack {
  return {
    canDecode: async () => true,
    getDisplayWidth: () => 1920,
    getDisplayHeight: () => 1080,
    computeFrameRateMetrics: async () => ({ bestGuessFrameRate: 30 }),
  } as unknown as InputVideoTrack;
}

function input(overrides: Partial<Input<UrlSource>> = {}): Input<UrlSource> {
  return {
    canRead: async () => true,
    getPrimaryVideoTrack: async () => videoTrack(),
    getPrimaryAudioTrack: async () => null,
    computeDuration: async () => 5,
    dispose: () => undefined,
    ...overrides,
  } as unknown as Input<UrlSource>;
}

describe("MediabunnyWebCodecsSource", () => {
  it("shares one in-flight preparation and gives the resulting input one owner", async () => {
    let finishCanRead!: (readable: boolean) => void;
    let inputs = 0;
    let disposed = 0;
    const source = new MediabunnyWebCodecsSource("test://media", {
      inputFactory: () => {
        inputs += 1;
        return input({
          canRead: () => new Promise<boolean>((resolve) => (finishCanRead = resolve)),
          dispose: () => {
            disposed += 1;
          },
        });
      },
      videoSinkFactory: () => ({}) as VideoSampleSink,
    });

    const first = source.prepare();
    const second = source.prepare();
    expect(inputs).toBe(1);
    finishCanRead(true);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ durationUs: 5_000_000, hasAudio: false }),
      expect.objectContaining({ durationUs: 5_000_000, hasAudio: false }),
    ]);
    expect(disposed).toBe(0);

    source.destroy();
    expect(disposed).toBe(1);
  });

  it("disposes partial construction and allows preparation to be retried", async () => {
    let inputs = 0;
    let disposed = 0;
    const source = new MediabunnyWebCodecsSource("test://failure", {
      inputFactory: () => {
        inputs += 1;
        return input({
          computeDuration: async () => {
            throw new Error("metadata failed");
          },
          dispose: () => {
            disposed += 1;
          },
        });
      },
      videoSinkFactory: () => ({}) as VideoSampleSink,
    });

    await expect(source.prepare()).rejects.toThrow("metadata failed");
    await expect(source.prepare()).rejects.toThrow("metadata failed");
    expect(inputs).toBe(2);
    expect(disposed).toBe(2);
  });

  it("disposes an input whose preparation completes after destruction", async () => {
    let finishCanRead!: (readable: boolean) => void;
    let disposed = 0;
    const source = new MediabunnyWebCodecsSource("test://canceled", {
      inputFactory: () =>
        input({
          canRead: () => new Promise<boolean>((resolve) => (finishCanRead = resolve)),
          dispose: () => {
            disposed += 1;
          },
        }),
      videoSinkFactory: () => ({}) as VideoSampleSink,
      audioSinkFactory: () => ({}) as AudioBufferSink,
    });
    const preparing = source.prepare();
    source.destroy();
    finishCanRead(true);

    await expect(preparing).rejects.toThrow("preparation was canceled");
    expect(disposed).toBe(1);
  });
});

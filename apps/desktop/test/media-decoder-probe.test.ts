import { describe, expect, it, vi } from "vite-plus/test";
import type { Asset } from "@cinesim/core";
import { timeUs } from "@cinesim/core";
import { applyMediaDecoderProbe } from "../src/main/projects/media-import";
import { probeMediaDecoders } from "../src/shared/media-decoder-probe";

function videoAsset(): Asset {
  return {
    id: "asset_probe",
    kind: "video",
    name: "Probe.mov",
    source: { kind: "local", path: "/media/probe.mov" },
    durationUs: timeUs(1_000_000),
    width: 1920,
    height: 1080,
    hasAudio: true,
    technical: {
      containerMimeType: "video/quicktime",
      durationSeconds: 1,
      compatibility: "unknown",
      video: {
        codec: "avc",
        codecParameters: "avc1.640028",
        decoderAvailability: "unknown",
        codedWidth: 1920,
        codedHeight: 1080,
        displayWidth: 1920,
        displayHeight: 1080,
        rotationDegrees: 0,
        pixelAspectRatio: { numerator: 1, denominator: 1 },
        frameRate: {
          mode: "constant",
          nominal: 30,
          minimum: 30,
          maximum: 30,
          average: 30,
          probedFrames: 30,
        },
        color: { hdr: false, uncertain: false },
      },
      audio: {
        codec: "aac",
        decoderAvailability: "unknown",
        sampleRate: 48_000,
        channels: 2,
        channelLayout: "stereo",
      },
    },
  };
}

describe("active decoder runtime probing", () => {
  it("checks exact bounded configs in the supplied Chromium runtime", async () => {
    const videoSupport = vi.fn(async () => ({ supported: true }));
    const audioSupport = vi.fn(async () => ({ supported: false }));
    const description = new Uint8Array([1, 2, 3]);

    const [result] = await probeMediaDecoders(
      [
        {
          assetId: "asset_probe",
          video: {
            availability: "unknown",
            config: {
              codec: "avc1.640028",
              codedWidth: 1920,
              codedHeight: 1080,
              description,
            },
          },
          audio: {
            availability: "unknown",
            config: { codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 2 },
          },
        },
      ],
      {
        video: { isConfigSupported: videoSupport },
        audio: { isConfigSupported: audioSupport },
      },
    );

    expect(videoSupport).toHaveBeenCalledWith({
      codec: "avc1.640028",
      codedWidth: 1920,
      codedHeight: 1080,
      description,
    });
    expect(audioSupport).toHaveBeenCalledWith({
      codec: "mp4a.40.2",
      sampleRate: 48_000,
      numberOfChannels: 2,
    });
    expect(result).toEqual({ assetId: "asset_probe", video: "supported", audio: "unsupported" });
  });

  it("retains known custom-decoder support and rejects tracks when WebCodecs is absent", async () => {
    await expect(
      probeMediaDecoders(
        [
          {
            assetId: "asset_audio",
            video: { availability: "unknown", config: { codec: "avc1.640028" } },
            audio: { availability: "supported", config: { codec: "pcm-s16" } },
          },
        ],
        {},
      ),
    ).resolves.toEqual([{ assetId: "asset_audio", video: "unsupported", audio: "supported" }]);
  });

  it("commits runtime results into compatibility before derived jobs inspect the asset", () => {
    const asset = videoAsset();
    expect(
      applyMediaDecoderProbe(asset, {
        assetId: asset.id,
        video: "supported",
        audio: "unsupported",
      }).technical,
    ).toMatchObject({
      compatibility: "partial",
      video: { decoderAvailability: "supported" },
      audio: { decoderAvailability: "unsupported" },
    });
    expect(
      applyMediaDecoderProbe(asset, {
        assetId: asset.id,
        video: "unsupported",
        audio: "supported",
      }).technical?.compatibility,
    ).toBe("unsupported");
  });
});

import { basename } from "node:path";
import { nextId } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";

export async function inspectMedia(filePath: string, existingIds: string[]): Promise<Asset> {
  const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) throw new Error("Unsupported media file");
    const [video, audio, durationSeconds] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
      input.computeDuration(),
    ]);
    return {
      id: nextId("asset", existingIds),
      kind: video ? "video" : audio ? "audio" : "image",
      name: basename(filePath),
      source: { kind: "local", path: filePath },
      durationUs: Math.max(1, Math.round(durationSeconds * 1_000_000)),
      ...(video
        ? {
            width: await video.getDisplayWidth(),
            height: await video.getDisplayHeight(),
            frameRate: (await video.computeFrameRateMetrics({ targetPacketCount: 128 }))
              .bestGuessFrameRate,
          }
        : {}),
      hasAudio: Boolean(audio),
    };
  } finally {
    input.dispose();
  }
}

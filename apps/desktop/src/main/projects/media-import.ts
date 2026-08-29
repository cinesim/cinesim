import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";
import { nextId, secondsToTimeUs, timeSeconds, timeUs } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";

export async function isTemporaryMediaSelection(
  filePath: string,
  options: { platform?: NodeJS.Platform; temporaryDirectory?: string } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const [canonicalFile, canonicalTemporaryDirectory] = await Promise.all([
    realpath(filePath),
    realpath(options.temporaryDirectory ?? tmpdir()),
  ]);
  const pathFromTemporaryDirectory = relative(canonicalTemporaryDirectory, canonicalFile);
  return (
    pathFromTemporaryDirectory !== "" &&
    pathFromTemporaryDirectory !== ".." &&
    !pathFromTemporaryDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromTemporaryDirectory)
  );
}

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
      durationUs: timeUs(Math.max(1, secondsToTimeUs(timeSeconds(durationSeconds)))),
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

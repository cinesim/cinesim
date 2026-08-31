import type { IrClip, IrComposition, IrProgram, IrTransform } from "@cinesim/ir";

export function selectedVisualClip(
  program: IrProgram,
  sequenceId: string,
  clipId: string | null,
  playheadUs: number,
): { clip: IrClip; composition: IrComposition } | null {
  if (!clipId) return null;
  const composition = program.compositions.find((candidate) => candidate.id === sequenceId);
  if (!composition) return null;
  for (const track of composition.timeline.tracks) {
    if (track.kind === "audio" || track.muted) continue;
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (
      clip?.enabled &&
      playheadUs >= clip.timelineStartUs &&
      playheadUs < clip.timelineStartUs + clip.durationUs
    )
      return { clip, composition };
  }
  return null;
}

export function programWithClipTransform(
  program: IrProgram,
  clipId: string,
  transform: IrTransform,
): IrProgram {
  return {
    ...program,
    compositions: program.compositions.map((composition) => ({
      ...composition,
      timeline: {
        ...composition.timeline,
        tracks: composition.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, transform: { ...transform } } : clip,
          ),
        })),
      },
    })),
  };
}

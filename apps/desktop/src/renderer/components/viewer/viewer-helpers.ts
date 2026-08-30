import { timeUs } from "@cinesim/core";
import type { TimeUs } from "@cinesim/core";

export type ViewerScale = "fit" | "0.5" | "1" | "2";

export type PlaybackShortcutAction =
  | "go-to-start"
  | "shuttle-backward"
  | "shuttle-forward"
  | "shuttle-stop"
  | "step-backward"
  | "step-forward"
  | "toggle-playback";

interface PlaybackShortcutEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
}

export const VIEWER_SCALE_OPTIONS: ReadonlyArray<{ value: ViewerScale; label: string }> = [
  { value: "fit", label: "Fit" },
  { value: "0.5", label: "50%" },
  { value: "1", label: "100%" },
  { value: "2", label: "200%" },
];

export function playbackShortcutAction(
  event: PlaybackShortcutEvent,
): PlaybackShortcutAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return null;
  if (event.code === "Space") return "toggle-playback";
  switch (event.key.toLowerCase()) {
    case "j":
      return "shuttle-backward";
    case "k":
      return "shuttle-stop";
    case "l":
      return "shuttle-forward";
    case "arrowleft":
      return "step-backward";
    case "arrowright":
      return "step-forward";
    case "home":
      return "go-to-start";
    default:
      return null;
  }
}

export function viewerDisplaySize(
  source: { width: number; height: number },
  stage: { width: number; height: number },
  scale: ViewerScale,
  padding = 40,
): { width: number; height: number } {
  const safeWidth = Math.max(1, source.width);
  const safeHeight = Math.max(1, source.height);
  const factor =
    scale === "fit"
      ? Math.min(
          1,
          Math.max(1, stage.width - padding) / safeWidth,
          Math.max(1, stage.height - padding) / safeHeight,
        )
      : Number(scale);
  return {
    width: Math.max(1, Math.round(safeWidth * factor)),
    height: Math.max(1, Math.round(safeHeight * factor)),
  };
}

export function shouldShowTimelineEmptyState(
  durationUs: number,
  mode: { kind: "timeline" | "asset" } | null,
): boolean {
  return durationUs === 0 && mode?.kind !== "asset";
}

export function steppedSourceTimeUs(
  currentTimeUs: TimeUs,
  durationUs: TimeUs,
  frameRate: number,
  deltaFrames: number,
): TimeUs {
  const safeRate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 30;
  const frameCount = Math.max(1, Math.ceil((durationUs * safeRate) / 1_000_000));
  const currentFrame = Math.max(
    0,
    Math.floor((Math.max(0, currentTimeUs) * safeRate) / 1_000_000 + 0.000_1),
  );
  const targetFrame = Math.max(0, Math.min(currentFrame + deltaFrames, frameCount - 1));
  return timeUs(Math.min(durationUs, Math.round((targetFrame * 1_000_000) / safeRate)));
}
